/**
 * Puerta para agentes de IA («402 en pesos con CoDi»):
 *
 *   GET  /agente/oferta.json          catálogo legible por máquina (programas, colegiaturas, cupo y protocolo 402 CoDi)
 *   GET  /llms.txt                    guía en Markdown para agentes (ChatGPT, Claude, etc.)
 *   POST /api/agente/apartar          solicita apartar lugar (alias: POST /api/inscripcion)
 *                                     • sin pago conciliado → HTTP 402 Payment Required con cobro CoDi (QR o push)
 *                                     • con payment_token ya pagado → HTTP 200 OK («Inscrito · Pagado»)
 *   GET  /api/agente/apartar/:token   poll_url para verificar si la familia ya autorizó el cobro en su banco
 */
import { conciliar, nuevaReferencia, type CobroActivo, type Lead, type Resultado } from "./conciliacion.ts";
import { CELULAR_DEMO, ESCUELA_DEMO, VIGENCIA_SEGUNDOS, leadsDeEjemplo } from "./demo.ts";
import { AVISO_PRIVACIDAD, mensajeAntesDelCobro, pesos } from "./mensajes.ts";
import { beneficiarioSegunModo, celularDestino, cuotaSegunModo, type EnvModo } from "./modo.ts";
import {
  validarCelular,
  validarPoliticaCobro,
  type PagoRecibido,
  type PagosCoDi,
  type SolicitudCobro,
} from "./pagos/tipos.ts";
import { qrSvg } from "./qr.ts";
import { estaVigente } from "./vencimiento.ts";

export const ESCUELA_AGENTE_DEFAULT = "demo-agente01";
const ESCUELA_RE = /^demo-[a-z0-9]{8,24}$/;

export interface ProgramaOferta {
  id: string;
  grado: string;
  nivel: "Preescolar" | "Primaria" | "Secundaria";
  inscripcionCatalogoMXN: number;
  colegiaturaMensualMXN: number;
  colegiaturasPorCiclo: number;
  cupoTotal: number;
  /** ≤ 40 caracteres, sin acentos ni datos personales (viaja en la orden SPEI/CoDi). */
  conceptoCodi: string;
}

export const PROGRAMAS_OFERTA: readonly ProgramaOferta[] = [
  {
    id: "kinder-2",
    grado: "Kínder 2",
    nivel: "Preescolar",
    inscripcionCatalogoMXN: 4200,
    colegiaturaMensualMXN: 5400,
    colegiaturasPorCiclo: 10,
    cupoTotal: 8,
    conceptoCodi: "Inscripcion 2027-28 Kinder 2",
  },
  {
    id: "1-primaria",
    grado: "1° primaria",
    nivel: "Primaria",
    inscripcionCatalogoMXN: 4850,
    colegiaturaMensualMXN: 6200,
    colegiaturasPorCiclo: 10,
    cupoTotal: 6,
    conceptoCodi: "Inscripcion 2027-28 1o primaria",
  },
  {
    id: "2-primaria",
    grado: "2° primaria",
    nivel: "Primaria",
    inscripcionCatalogoMXN: 4850,
    colegiaturaMensualMXN: 6200,
    colegiaturasPorCiclo: 10,
    cupoTotal: 6,
    conceptoCodi: "Inscripcion 2027-28 2o primaria",
  },
  {
    id: "3-primaria",
    grado: "3° primaria",
    nivel: "Primaria",
    inscripcionCatalogoMXN: 4850,
    colegiaturaMensualMXN: 6200,
    colegiaturasPorCiclo: 10,
    cupoTotal: 6,
    conceptoCodi: "Inscripcion 2027-28 3o primaria",
  },
  {
    id: "1-secundaria",
    grado: "1° secundaria",
    nivel: "Secundaria",
    inscripcionCatalogoMXN: 5600,
    colegiaturaMensualMXN: 7100,
    colegiaturasPorCiclo: 10,
    cupoTotal: 8,
    conceptoCodi: "Inscripcion 2027-28 1o secundaria",
  },
];

/** Subconjunto del Durable Object `Tablero` que usa el flujo de agentes (permite probar en Node sin workerd). */
export interface AlmacenAgente {
  estado(): Promise<{ leads: Lead[] }>;
  lead(leadId: string): Promise<{ lead?: Lead; celular?: string; leads: Lead[] }>;
  crearLeadDemo(lead: Lead, celular: string, escuela?: string): Promise<Lead>;
  guardarCobro(leadId: string, cobro: CobroActivo): Promise<void>;
  aplicarPago(webhookId: string, pago: PagoRecibido): Promise<{ resultado: Resultado; lead?: Lead }>;
}

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function resolverPrograma(entrada?: string): ProgramaOferta {
  const q = normalizar(entrada ?? "");
  if (!q) return PROGRAMAS_OFERTA[1]!; // 1° primaria por defecto
  return (
    PROGRAMAS_OFERTA.find((p) => normalizar(p.id) === q || normalizar(p.grado) === q) ??
    PROGRAMAS_OFERTA.find((p) => normalizar(p.grado).includes(q) || q.includes(normalizar(p.id))) ??
    PROGRAMAS_OFERTA[1]!
  );
}

export function cuotaProgramaSegunModo(
  env: EnvModo,
  programa: ProgramaOferta,
): { grado: string; montoMXN: number; concepto: string } {
  if (env.PAGOS_PROVEEDOR === "pey" && env.PEY_MONTO_PRUEBA_MXN) {
    const base = cuotaSegunModo(env);
    return { grado: programa.grado, montoMXN: base.montoMXN, concepto: base.concepto };
  }
  return {
    grado: programa.grado,
    montoMXN: programa.inscripcionCatalogoMXN,
    concepto: programa.conceptoCodi,
  };
}

export function validarEscuelaAgente(entrada?: unknown): string {
  if (entrada === undefined || entrada === null || entrada === "") return ESCUELA_AGENTE_DEFAULT;
  const e = String(entrada).trim();
  if (!ESCUELA_RE.test(e)) throw new Error("escuela inválida (usa demo- seguido de 8 a 24 caracteres alfanuméricos)");
  return e;
}

/** Extrae `{ escuela, busqueda }` de un `payment_token` (`demo-agente01.lead-...` o id directo). */
export function desglosarTokenPago(
  tokenCrudo: string,
  escuelaFallback = ESCUELA_AGENTE_DEFAULT,
): { escuela: string; busqueda: string } {
  const limpio = tokenCrudo.trim();
  const punto = limpio.indexOf(".");
  if (punto > 0) {
    const prefijo = limpio.slice(0, punto);
    const resto = limpio.slice(punto + 1);
    if (ESCUELA_RE.test(prefijo) && resto) {
      return { escuela: prefijo, busqueda: resto };
    }
  }
  return { escuela: validarEscuelaAgente(escuelaFallback), busqueda: limpio };
}

export function extraerTokenDeSolicitud(req: Request, body: Record<string, unknown>, url: URL): string | undefined {
  const hToken =
    req.headers.get("x-payment-token") ??
    req.headers.get("x-payment") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice(7).trim()
      : undefined);
  if (hToken?.trim()) return hToken.trim();

  for (const campo of ["payment_token", "transaction_token", "token", "transaccionId", "codi_qr_id", "lead_id", "leadId"]) {
    const val = body[campo];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  const qToken = url.searchParams.get("payment_token") ?? url.searchParams.get("token");
  if (qToken?.trim()) return qToken.trim();
  return undefined;
}

export function construirOfertaAgente(
  env: EnvModo,
  origen: string,
  leads: Lead[] = leadsDeEjemplo(),
  escuela = ESCUELA_AGENTE_DEFAULT,
) {
  const baseLeads = leads.length ? leads : leadsDeEjemplo();
  const beneficiario = beneficiarioSegunModo(env);
  const programas = PROGRAMAS_OFERTA.map((p) => {
    const cuota = cuotaProgramaSegunModo(env, p);
    const inscritos = baseLeads.filter((l) => l.etapa === "pagado" && normalizar(l.grado) === normalizar(p.grado)).length;
    const disponibles = Math.max(0, p.cupoTotal - inscritos);
    return {
      id: p.id,
      grado: p.grado,
      nivel: p.nivel,
      inscripcion_mxn: cuota.montoMXN,
      inscripcion_catalogo_mxn: p.inscripcionCatalogoMXN,
      colegiatura_mensual_mxn: p.colegiaturaMensualMXN,
      colegiaturas_por_ciclo: p.colegiaturasPorCiclo,
      currency: "MXN" as const,
      rail: "CoDi" as const,
      commission_pct: 0 as const,
      cupo_total: p.cupoTotal,
      inscritos_pagados: inscritos,
      lugares_disponibles: disponibles,
      concepto_codi: cuota.concepto,
    };
  });

  const lugaresDisponiblesTotal = programas.reduce((acc, p) => acc + p.lugares_disponibles, 0);

  return {
    schema: "inscrito.agent-offer.v1",
    proyecto: "Inscrito",
    descripcion:
      "Oferta pública legible por agentes de IA para consultar programas, colegiaturas y lugares disponibles, y apartar la inscripción en pesos mexicanos (MXN) vía CoDi sin comisión mediante HTTP 402 Payment Required.",
    escuela: {
      id: escuela,
      nombre: ESCUELA_DEMO.nombre,
      razon_social_beneficiario: beneficiario,
      ciclo: ESCUELA_DEMO.ciclo,
      pais: "MX",
      moneda: "MXN",
    },
    pago: {
      protocol: "x402-codi-mxn",
      http_status_sin_pago: 402,
      rail: "CoDi",
      red: "SPEI · Banco de México",
      provider: env.PAGOS_PROVEEDOR,
      currency: "MXN",
      commission_pct: 0,
      commission_mxn: 0,
      requiere_aprobacion_humana: true,
      aprobacion_humana:
        "El padre, madre o tutor autoriza el Mensaje de Cobro con Face ID / huella en la app de su banco (Aceptar, Rechazar o Posponer). El dinero va directo a la CLABE del colegio.",
    },
    programas,
    lugares_disponibles_total: lugaresDisponiblesTotal,
    endpoints: {
      oferta_json: `${origen}/agente/oferta.json`,
      llms_txt: `${origen}/llms.txt`,
      apartar: `${origen}/api/agente/apartar`,
      inscripcion_alias: `${origen}/api/inscripcion`,
      poll_apartado: `${origen}/api/agente/apartar/{payment_token}`,
    },
    flujo_402_codi: [
      {
        paso: 1,
        accion: "POST /api/agente/apartar (o POST /api/inscripcion) con { familia, grado, celular }",
        respuesta: "HTTP 402 Payment Required con amount_mxn, currency: 'MXN', rail: 'CoDi', commission_pct: 0, codi_qr_id, approval_url, push_status, poll_url y payment_token.",
      },
      {
        paso: 2,
        accion: "La familia aprueba el cobro CoDi con Face ID / huella en la app de su banco (sin comisión).",
        respuesta: "Pey notifica a POST /webhooks/codi (Standard Webhooks HMAC-SHA256) y el tablero concilia monto + referencia.",
      },
      {
        paso: 3,
        accion: "El agente consulta poll_url (GET /api/agente/apartar/{payment_token}) o repite POST /api/agente/apartar con X-Payment-Token: <payment_token>.",
        respuesta: "HTTP 200 OK con status: 'inscrito' y etapa: 'Inscrito · Pagado'.",
      },
    ],
  };
}

export function construirLlmsTxt(env: EnvModo, origen: string, leads: Lead[] = leadsDeEjemplo()): string {
  const oferta = construirOfertaAgente(env, origen, leads);
  const filasProgramas = oferta.programas
    .map(
      (p) =>
        `- **${p.grado}** (\`${p.id}\`, ${p.nivel}): inscripción **${pesos(p.inscripcion_mxn)} MXN** (catálogo ${pesos(p.inscripcion_catalogo_mxn)} MXN) · colegiatura mensual **${pesos(p.colegiatura_mensual_mxn)} MXN** (${p.colegiaturas_por_ciclo} meses) · **${p.lugares_disponibles} lugares disponibles** (de ${p.cupo_total}) · comisión **0%**.`,
    )
    .join("\n");

  return [
    `# Inscrito — ${ESCUELA_DEMO.nombre} (Ciclo ${ESCUELA_DEMO.ciclo})`,
    "",
    `> Admisiones escolares e inscripción inmediata pagada en pesos mexicanos (MXN) sobre **CoDi® (SPEI · Banco de México)** con **0% de comisión**, lista para agentes de IA (ChatGPT, Claude, etc.) mediante el flujo **HTTP 402 Payment Required**.`,
    "",
    "## Recursos legibles por agentes",
    `- Oferta estructurada (JSON): ${origen}/agente/oferta.json`,
    `- Guía para LLMs (este archivo): ${origen}/llms.txt`,
    `- Endpoint para apartar e inscribir (POST): ${origen}/api/agente/apartar`,
    `- Alias de inscripción (POST): ${origen}/api/inscripcion`,
    `- Verificación de pago / polling (GET): ${origen}/api/agente/apartar/{payment_token}`,
    "",
    "## Escuela y beneficiario CoDi",
    `- **Escuela:** ${oferta.escuela.nombre}`,
    `- **Beneficiario en la app bancaria:** ${oferta.escuela.razon_social_beneficiario}`,
    `- **Ciclo escolar:** ${oferta.escuela.ciclo}`,
    `- **Riel de pago:** CoDi (SPEI 24x7, Banco de México) vía ${oferta.pago.provider}`,
    `- **Moneda y comisión:** MXN · 0% de comisión ($0.00 MXN)`,
    `- **Lugares disponibles totales:** ${oferta.lugares_disponibles_total}`,
    "",
    "## Programas, colegiaturas y lugares disponibles",
    filasProgramas,
    "",
    "## Cómo apartar y pagar un lugar desde un agente de IA (Flujo HTTP 402 CoDi)",
    "",
    "### Paso 1: Solicitar el apartado sin transacción pagada (`HTTP 402 Payment Required`)",
    `Envía \`POST ${origen}/api/agente/apartar\` (o \`POST ${origen}/api/inscripcion\`) con JSON:`,
    "```json",
    '{',
    '  "familia": "Familia Gómez",',
    '  "grado": "1-primaria",',
    '  "celular": "0000000042",',
    '  "medio": "qr"',
    '}',
    "```",
    "El servidor crea el lead en el tablero de admisiones, genera un Mensaje de Cobro CoDi y responde **`HTTP 402 Payment Required`** con:",
    "- `amount_mxn`, `currency: \"MXN\"`, `rail: \"CoDi\"`, `commission_pct: 0`",
    "- `codi_qr_id`, `qr_string`, `push_status`, `referencia`, `beneficiario`",
    "- `payment_token` (token de la solicitud)",
    "- `approval_url` (pantalla donde el padre/tutor ve el cobro) y `poll_url` (`GET /api/agente/apartar/{payment_token}`)",
    "",
    "### Paso 2: Autorización humana con Face ID / huella en la app bancaria",
    "El agente muestra a la familia el monto, beneficiario, referencia y QR (o avisa que llegó la notificación push CoDi a su banco). El padre o tutor autoriza con Face ID o huella en su app bancaria. El pago viaja por SPEI sin comisión directo a la CLABE del colegio.",
    "",
    "### Paso 3: Confirmar la inscripción (`HTTP 200 OK`)",
    `Una vez autorizado el cobro, el agente consulta \`GET ${origen}/api/agente/apartar/{payment_token}\` o repite \`POST ${origen}/api/agente/apartar\` enviando el encabezado \`X-Payment-Token: {payment_token}\` (o \`"payment_token"\` en el cuerpo JSON).`,
    "El servidor responde **`HTTP 200 OK`** con `status: \"inscrito\"` y `etapa: \"Inscrito · Pagado\"`.",
    "",
  ].join("\n");
}

function armarRespuesta402(opciones: {
  env: EnvModo;
  origen: string;
  escuela: string;
  lead: Lead;
  cobro: CobroActivo;
  pushStatus: "sent" | "qr_ready" | "fallback_qr" | "qr_only_test_mode";
}): Response {
  const { env, origen, escuela, lead, cobro, pushStatus } = opciones;
  const beneficiario = beneficiarioSegunModo(env);
  const token = `${escuela}.${lead.id}`;
  const pollUrl = `${origen}/api/agente/apartar/${encodeURIComponent(token)}`;
  const approvalUrl = `${origen}/?escuela=${encodeURIComponent(escuela)}&lead=${encodeURIComponent(lead.id)}`;

  const payload = {
    status: "payment_required" as const,
    http_status: 402 as const,
    protocol: "x402-codi-mxn" as const,
    amount_mxn: cobro.montoMXN,
    currency: "MXN" as const,
    rail: "CoDi" as const,
    commission_pct: 0 as const,
    commission_mxn: 0 as const,
    provider: env.PAGOS_PROVEEDOR,
    beneficiario,
    concepto: cobro.concepto,
    referencia: cobro.referencia,
    expira_en: cobro.expiraEn,
    payment_token: token,
    transaction_token: token,
    lead_id: lead.id,
    escuela,
    familia: lead.familia,
    grado: lead.grado,
    medio: cobro.medio,
    codi_qr_id: cobro.id,
    codi_transaction_id: cobro.medio === "push" ? cobro.id : null,
    folio_codi: cobro.folioCodi ?? cobro.id,
    qr_string: cobro.qrString ?? null,
    qr_svg: cobro.qrString ? qrSvg(cobro.qrString) : undefined,
    push_status: pushStatus,
    approval_url: approvalUrl,
    poll_url: pollUrl,
    retry_url: `${origen}/api/agente/apartar`,
    ...(env.PAGOS_PROVEEDOR === "mock" ? { demo_accept_url: `${origen}/api/demo/aceptar` } : {}),
    mensaje_familia: mensajeAntesDelCobro(cobro, beneficiario),
    aviso_privacidad: AVISO_PRIVACIDAD,
    instrucciones_agente:
      "Pago requerido en MXN por CoDi (0% comisión). Muestra a la familia el beneficiario, monto y referencia (o el QR / approval_url) para que apruebe con Face ID / huella en la app de su banco. Luego consulta poll_url o repite este POST con X-Payment-Token para recibir 200 OK «Inscrito».",
  };

  return new Response(JSON.stringify(payload), {
    status: 402,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `x402-codi realm="Inscrito", rail="CoDi", currency="MXN", amount="${cobro.montoMXN}", token="${token}"`,
    },
  });
}

function armarRespuesta200Inscrito(opciones: {
  env: EnvModo;
  escuela: string;
  lead: Lead;
}): Response {
  const { env, escuela, lead } = opciones;
  const beneficiario = beneficiarioSegunModo(env);
  const token = `${escuela}.${lead.id}`;
  const payload = {
    status: "inscrito" as const,
    http_status: 200 as const,
    etapa: "Inscrito · Pagado" as const,
    mensaje: `Inscripción confirmada y conciliada por CoDi sin comisión para ${lead.familia} (${lead.grado}, ciclo ${ESCUELA_DEMO.ciclo}).`,
    payment_token: token,
    transaction_token: lead.pago?.transaccionId ?? token,
    escuela: {
      id: escuela,
      nombre: ESCUELA_DEMO.nombre,
      razon_social_beneficiario: beneficiario,
      ciclo: ESCUELA_DEMO.ciclo,
    },
    inscripcion: {
      lead_id: lead.id,
      familia: lead.familia,
      grado: lead.grado,
      ciclo: ESCUELA_DEMO.ciclo,
      etapa: lead.etapa,
      etapa_nombre: "Inscrito · Pagado",
    },
    pago: {
      rail: "CoDi" as const,
      currency: "MXN" as const,
      amount_mxn: lead.pago?.montoMXN ?? lead.cobro?.montoMXN ?? 0,
      commission_pct: 0 as const,
      commission_mxn: 0 as const,
      provider: env.PAGOS_PROVEEDOR,
      medio: lead.pago?.medio ?? lead.cobro?.medio ?? "qr",
      transaction_id: lead.pago?.transaccionId ?? lead.cobro?.id ?? "",
      folio_codi: lead.pago?.folioCodi ?? lead.cobro?.folioCodi ?? lead.cobro?.id ?? "",
      referencia: lead.cobro?.referencia ?? "",
      clave_rastreo: lead.pago?.claveRastreo ?? null,
      clabe_ordenante: lead.pago?.clabeOrdenante ?? null,
      pagado_en: lead.pago?.pagadoEn ?? 0,
      conciliado_en: lead.pago?.conciliadoEn ?? 0,
    },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function buscarYVerificarLeadPorToken(opciones: {
  busqueda: string;
  escuela: string;
  almacen: AlmacenAgente;
  pagos: PagosCoDi;
}): Promise<Lead | undefined> {
  const { busqueda, escuela, almacen, pagos } = opciones;
  const { lead: directo, leads } = await almacen.lead(busqueda);
  let encontrado =
    directo ??
    leads.find(
      (l) =>
        l.id === busqueda ||
        l.cobro?.id === busqueda ||
        l.cobro?.folioCodi === busqueda ||
        l.pago?.transaccionId === busqueda ||
        l.pago?.folioCodi === busqueda,
    );
  if (!encontrado) return undefined;

  // Si aún no figura como pagado pero tiene un cobro activo, consultamos al proveedor (útil si el webhook tardó).
  if (encontrado.etapa !== "pagado" && encontrado.cobro) {
    try {
      const est = await pagos.estadoCobro({ medio: encontrado.cobro.medio, id: encontrado.cobro.id });
      if (est.estado === "PAGADO") {
        const txId = est.transaccionId ?? encontrado.cobro.id;
        const { lead: actualizado } = await almacen.aplicarPago(`poll_${txId}`, {
          medio: encontrado.cobro.medio,
          transaccionId: txId,
          cobroId: encontrado.cobro.medio === "qr" ? encontrado.cobro.id : undefined,
          montoMXN: est.montoMXN ?? encontrado.cobro.montoMXN,
          referencia: encontrado.cobro.referencia,
          concepto: encontrado.cobro.concepto,
          pagadoEn: est.pagadoEn ?? Math.floor(Date.now() / 1000),
          claveRastreo: est.claveRastreo,
          metadatos: { escuelaId: escuela, leadId: encontrado.id },
        });
        if (actualizado) encontrado = actualizado;
      }
    } catch {
      /* Si falla la consulta en línea, confiamos en el estado actual del tablero. */
    }
  }
  return encontrado;
}

async function emitirCobroParaLead(opciones: {
  env: EnvModo;
  pagos: PagosCoDi;
  almacen: AlmacenAgente;
  escuela: string;
  lead: Lead;
  celular: string;
  medioPreferido: "qr" | "push";
  montoMXN: number;
  concepto: string;
  leadsExistentes: Lead[];
  datosPrivados?: string[];
}): Promise<{ cobro: CobroActivo; pushStatus: "sent" | "qr_ready" | "fallback_qr" | "qr_only_test_mode" }> {
  const { env, pagos, almacen, escuela, lead, celular, medioPreferido, montoMXN, concepto, leadsExistentes, datosPrivados } =
    opciones;
  const solicitud: SolicitudCobro = {
    montoMXN,
    concepto,
    referencia: nuevaReferencia(leadsExistentes),
    vigenciaSegundos: VIGENCIA_SEGUNDOS,
    metadatos: { escuelaId: escuela, leadId: lead.id, origen: "agente_402" },
  };
  validarPoliticaCobro(solicitud, { montoConfirmadoMXN: montoMXN, datosPrivados });

  const ahora = Date.now();
  let cobro: CobroActivo;
  let pushStatus: "sent" | "qr_ready" | "fallback_qr" | "qr_only_test_mode";

  if (medioPreferido === "push") {
    const destino = celularDestino(env, celular);
    if (destino) {
      const c = await pagos.crearCobroPush(destino, solicitud);
      cobro = { ...c, medio: "push", id: c.transaccionId, creadoEn: ahora, estado: "vigente" };
      pushStatus = "sent";
    } else {
      // En modo pey sin PEY_CELULAR_PRUEBA, respaldamos con QR real en api.pey.mx para no bloquear al agente.
      const c = await pagos.crearCobroQR(solicitud);
      cobro = { ...c, medio: "qr", creadoEn: ahora, estado: "vigente" };
      pushStatus = "fallback_qr";
    }
  } else {
    const c = await pagos.crearCobroQR(solicitud);
    cobro = { ...c, medio: "qr", creadoEn: ahora, estado: "vigente" };
    pushStatus = env.PAGOS_PROVEEDOR === "pey" && !celularDestino(env, celular) ? "qr_only_test_mode" : "qr_ready";
  }

  await almacen.guardarCobro(lead.id, cobro);
  return { cobro, pushStatus };
}

/** Maneja `GET /api/agente/apartar/:token` (o `?payment_token=...`). */
export async function consultarApartadoAgente(opciones: {
  tokenCrudo: string;
  escuelaFallback?: string;
  env: EnvModo;
  origen: string;
  obtenerAlmacen: (escuela: string) => AlmacenAgente;
  pagos: PagosCoDi;
}): Promise<Response> {
  const { tokenCrudo, escuelaFallback, env, origen, obtenerAlmacen, pagos } = opciones;
  let escuela: string;
  let busqueda: string;
  try {
    ({ escuela, busqueda } = desglosarTokenPago(tokenCrudo, escuelaFallback));
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const almacen = obtenerAlmacen(escuela);
  const lead = await buscarYVerificarLeadPorToken({ busqueda, escuela, almacen, pagos });
  if (!lead) {
    return new Response(JSON.stringify({ error: "apartado o payment_token no encontrado" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  if (lead.etapa === "pagado") {
    return armarRespuesta200Inscrito({ env, escuela, lead });
  }
  if (lead.cobro) {
    const pushStatus = lead.cobro.medio === "push" ? "sent" : "qr_ready";
    return armarRespuesta402({ env, origen, escuela, lead, cobro: lead.cobro, pushStatus });
  }
  return new Response(JSON.stringify({ error: "el apartado no tiene un cobro activo" }), {
    status: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Maneja `POST /api/agente/apartar` y `POST /api/inscripcion`.
 * - Sin token pagado → crea lead + cobro CoDi y devuelve `402 Payment Required`.
 * - Con token ya pagado → devuelve `200 OK` («Inscrito · Pagado»).
 */
export async function procesarApartadoAgente(opciones: {
  req: Request;
  body: Record<string, unknown>;
  url: URL;
  env: EnvModo;
  obtenerAlmacen: (escuela: string) => AlmacenAgente;
  pagos: PagosCoDi;
}): Promise<Response> {
  const { req, body, url, env, obtenerAlmacen, pagos } = opciones;
  const origen = url.origin;
  const tokenCrudo = extraerTokenDeSolicitud(req, body, url);

  if (tokenCrudo) {
    let escuela: string;
    let busqueda: string;
    try {
      ({ escuela, busqueda } = desglosarTokenPago(
        tokenCrudo,
        typeof body.escuela === "string" ? body.escuela : ESCUELA_AGENTE_DEFAULT,
      ));
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const almacen = obtenerAlmacen(escuela);
    const lead = await buscarYVerificarLeadPorToken({ busqueda, escuela, almacen, pagos });
    if (!lead) {
      return new Response(JSON.stringify({ error: "apartado o payment_token no encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (lead.etapa === "pagado") {
      return armarRespuesta200Inscrito({ env, escuela, lead });
    }
    if (lead.cobro && estaVigente(lead.cobro)) {
      const pushStatus = lead.cobro.medio === "push" ? "sent" : "qr_ready";
      return armarRespuesta402({ env, origen, escuela, lead, cobro: lead.cobro, pushStatus });
    }
    // Si el cobro anterior ya venció, emitimos uno nuevo con referencia nueva (nunca se reutiliza).
    const programa = resolverPrograma(lead.grado);
    const cuota = cuotaProgramaSegunModo(env, programa);
    const { celular, leads } = await almacen.lead(lead.id);
    const { cobro, pushStatus } = await emitirCobroParaLead({
      env,
      pagos,
      almacen,
      escuela,
      lead,
      celular: celular ?? CELULAR_DEMO,
      medioPreferido: body.medio === "push" ? "push" : "qr",
      montoMXN: cuota.montoMXN,
      concepto: cuota.concepto,
      leadsExistentes: leads,
    });
    return armarRespuesta402({ env, origen, escuela, lead: { ...lead, cobro }, cobro, pushStatus });
  }

  let escuela: string;
  try {
    escuela = validarEscuelaAgente(body.escuela);
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const familia = String(body.familia ?? "Familia Agente IA (demo)").trim().slice(0, 80) || "Familia Agente IA (demo)";
  const celular =
    body.celular === undefined || body.celular === null || body.celular === ""
      ? CELULAR_DEMO
      : String(body.celular).replace(/\D/g, "");
  try {
    validarCelular(celular);
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 422,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const programa = resolverPrograma(String(body.grado ?? body.programa ?? ""));
  const cuota = cuotaProgramaSegunModo(env, programa);
  const medioPreferido = body.medio === "push" ? "push" : "qr";
  const almacen = obtenerAlmacen(escuela);

  const nuevoLead: Lead = {
    id: "lead-ag-" + crypto.randomUUID().slice(0, 8),
    familia,
    grado: programa.grado,
    canal: "WhatsApp",
    etapa: "informes",
    demo: true,
  };
  await almacen.crearLeadDemo(nuevoLead, celular, escuela);
  const { leads } = await almacen.lead(nuevoLead.id);

  try {
    const datosPrivados = typeof body.nombreAlumno === "string" ? [body.nombreAlumno] : [];
    const { cobro, pushStatus } = await emitirCobroParaLead({
      env,
      pagos,
      almacen,
      escuela,
      lead: nuevoLead,
      celular,
      medioPreferido,
      montoMXN: cuota.montoMXN,
      concepto: cuota.concepto,
      leadsExistentes: leads,
      datosPrivados,
    });
    return armarRespuesta402({
      env,
      origen,
      escuela,
      lead: { ...nuevoLead, etapa: "cobro_enviado", cobro },
      cobro,
      pushStatus,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 422,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** Almacén en memoria compatible con `Tablero` para pruebas unitarias e integración en Node. */
export function crearAlmacenMemoria(leadsIniciales: Lead[] = leadsDeEjemplo()): AlmacenAgente {
  let leads: Lead[] = structuredClone(leadsIniciales);
  const celulares: Record<string, string> = {};
  const webhooks = new Set<string>();

  return {
    async estado() {
      return { leads: structuredClone(leads) };
    },
    async lead(leadId: string) {
      return {
        lead: structuredClone(leads.find((l) => l.id === leadId)),
        celular: celulares[leadId],
        leads: structuredClone(leads),
      };
    },
    async crearLeadDemo(lead: Lead, celular: string) {
      leads = [structuredClone(lead), ...leads.filter((l) => l.id !== lead.id)];
      celulares[lead.id] = celular;
      return structuredClone(lead);
    },
    async guardarCobro(leadId: string, cobro: CobroActivo) {
      leads = leads.map((l) => {
        if (l.id !== leadId) return l;
        const anteriores = l.cobro ? [...(l.cobrosAnteriores ?? []), { ...l.cobro, estado: "sustituido" as const }] : l.cobrosAnteriores;
        return {
          ...l,
          etapa: "cobro_enviado",
          cobro: { ...structuredClone(cobro), estado: "vigente" },
          ...(anteriores ? { cobrosAnteriores: anteriores } : {}),
        };
      });
    },
    async aplicarPago(webhookId: string, pago: PagoRecibido) {
      if (webhooks.has(webhookId)) {
        const dup = leads.find((l) => l.pago?.transaccionId === pago.transaccionId);
        return { resultado: { tipo: "duplicado", leadId: dup?.id ?? "" }, lead: dup };
      }
      const r = conciliar(leads, pago, Date.now());
      leads = r.leads;
      webhooks.add(webhookId);
      const id = "leadId" in r.resultado ? r.resultado.leadId : undefined;
      return { resultado: r.resultado, lead: structuredClone(leads.find((l) => l.id === id)) };
    },
  };
}
