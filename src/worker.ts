/**
 * Worker de «Inscripción con CoDi».
 *
 *   GET  /api/config               proveedor activo y tema de ntfy para suscribirse
 *   POST /api/demo/iniciar         crea un tablero de demo (un Durable Object por visitante)
 *   GET  /api/tablero              estado del CRM de admisiones
 *   POST /api/leads                la familia escribió por WhatsApp → lead «Informes enviados»
 *   POST /api/cobros               el agente manda el Mensaje de Cobro CoDi (push o QR)
 *   POST /api/demo/aceptar         SOLO MOCK: la familia toca «Aceptar» en su app bancaria;
 *                                  se emite un webhook firmado y se ENTREGA POR HTTP a /webhooks/codi
 *   POST /api/demo/vencer          SOLO MOCK: adelanta el reloj del cobro y corre la revisión de
 *                                  vencimiento (la misma que hace la alarma del Durable Object)
 *   POST /webhooks/codi            webhook real: verifica la firma (Standard Webhooks, HMAC-SHA256),
 *                                  deduplica por webhook-id, compara monto + referencia con el cobro
 *                                  original y SOLO entonces mueve a «Inscrito · Pagado» y avisa por ntfy
 *
 * Modo «Cobrar a un contacto» (WhatsApp Flow → push CoDi a cualquier contacto):
 *   POST /api/contactos/flow       el bot manda el Flow «Cobrar con CoDi» (nuevo flow_token)
 *   POST /api/demo/flow            SOLO DEMO: hace de cliente de WhatsApp: cifra el formulario con la llave
 *                                  pública del negocio, lo firma (X-Hub-Signature-256) y lo ENTREGA POR HTTP
 *                                  a /webhooks/whatsapp-flow; descifra la respuesta
 *   POST /webhooks/whatsapp-flow   endpoint data_exchange del Flow (forma de Meta): firma → descifra →
 *                                  valida → PagosCoDi.crearCobroPush(celular, …) → respuesta cifrada
 *   GET  /api/whatsapp-flow/llave-publica   la llave pública (la que el negocio sube a Meta)
 *
 * Agente facturador (CFDI 4.0, cualquier proveedor de timbrado; ver src/facturas.ts):
 *   POST /api/facturas · GET /api/facturas/:id · GET /api/facturas/:id/pdf · GET /api/facturas/:id/xml
 *   POST /api/facturas/:id/cancelar · POST /api/facturas/datos-fiscales
 *   POST /webhooks/facturacion     el proveedor avisa timbrada / cancelada / rechazada (Standard Webhooks)
 */
import { Tablero, type EstadoTablero } from "./tablero.ts";
import { nuevaReferencia, type CobroActivo, type Lead } from "./conciliacion.ts";
import { PagosCoDiMock } from "./pagos/mock.ts";
import { crearPagos, secretoWebhook, type SecretoBoveda } from "./pagos/fabrica.ts";
import { beneficiarioSegunModo, celularDestino, cuotaSegunModo } from "./modo.ts";
import { validarPoliticaCobro, type PagoRecibido, type SolicitudCobro } from "./pagos/tipos.ts";
import { estaVigente } from "./vencimiento.ts";
import { AVISO_PRIVACIDAD, mensajeAntesDelCobro, pesos } from "./mensajes.ts";
import { firmarWebhook, verificarWebhook } from "./webhooks.ts";
import { publicarNtfy, type ResultadoNtfy } from "./ntfy.ts";
import { qrSvg } from "./qr.ts";
import { CELULAR_DEMO, ESCUELA_DEMO, VIGENCIA_SEGUNDOS } from "./demo.ts";
import type { CobroContacto } from "./conciliacion.ts";
import {
  CONTACTOS_DEMO,
  PANTALLA_COBRO,
  bytesAB64,
  cifrarComoWhatsApp,
  datosPantallaCobro,
  descifrarRespuestaComoWhatsApp,
  escuelaDeFlowToken,
  firmarMeta,
  importarLlavePrivada,
  llavePublicaDe,
  nuevoFlowToken,
  procesarFlow,
  validarFormularioCobro,
  type Decision,
  type SolicitudFlow,
} from "./whatsapp-flow.ts";
import { enmascararCelular } from "./pagos/tipos.ts";
import {
  ESCUELA_AGENTE_DEFAULT,
  construirLlmsTxt,
  construirOfertaAgente,
  consultarApartadoAgente,
  desglosarTokenPago,
  procesarApartadoAgente,
  validarEscuelaAgente,
} from "./agente.ts";
import { crearFacturacion, secretoWebhookFacturacion } from "./facturacion/fabrica.ts";
import type { EnvFacturacion } from "./facturacion/tipos.ts";
import { rutasFacturas, webhookFacturacion, type AlmacenFacturas } from "./facturas.ts";

export { Tablero };

export interface Env extends EnvFacturacion {
  ASSETS: Fetcher;
  TABLERO: DurableObjectNamespace<Tablero>;
  /** Este mismo Worker (service binding) para entregar el webhook de la demo por HTTP. */
  YO?: Fetcher;
  PAGOS_PROVEEDOR: "mock" | "pey";
  NTFY_TEMA?: string;
  NTFY_BASE?: string;
  // Secretos (wrangler secret put …). Nunca en el repo.
  CODI_WEBHOOK_SECRET?: string;
  PEY_API_KEY?: string;
  /** bankAccountId (Pey) de la CLABE del colegio: el dinero cae directo ahí. */
  PEY_BANK_ACCOUNT_ID?: string;
  /** Bóveda (Secrets Store `superleads`): API key y secreto de webhooks de la CLABE de pruebas de pey. */
  PEY_API_KEY_TEST?: SecretoBoveda;
  PEY_WEBHOOK_SECRET_TEST?: SecretoBoveda;
  /** Modo pey: monto de prueba (p. ej. "0.01") y único celular que puede recibir un push real. */
  PEY_MONTO_PRUEBA_MXN?: string;
  PEY_CELULAR_PRUEBA?: string;
  NTFY_TOKEN?: string;
  /** Llave privada RSA del negocio para WhatsApp Flows (PKCS#8, PEM o base64). Secreto. */
  WA_FLOW_PRIVATE_KEY?: string;
  /** App secret de la app de Meta (firma X-Hub-Signature-256). Secreto. */
  WA_APP_SECRET?: string;
}

const ESCUELA_RE = /^demo-[a-z0-9]{8,24}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const pagos = crearPagos;

function tablero(env: Env, escuela: string) {
  return env.TABLERO.get(env.TABLERO.idFromName(escuela));
}

async function leerJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function escuelaDe(v: unknown): string {
  const e = String(v ?? "");
  if (!ESCUELA_RE.test(e)) throw new ErrorHttp(400, "escuela inválida");
  return e;
}

class ErrorHttp extends Error {
  status: number;
  constructor(status: number, mensaje: string) {
    super(mensaje);
    this.status = status;
  }
}

// ───────────────────────── webhook ─────────────────────────

async function webhookCodi(req: Request, env: Env): Promise<Response> {
  const secreto = await secretoWebhook(env);
  if (!secreto) return json({ error: "CODI_WEBHOOK_SECRET no configurado" }, 500);
  const cuerpo = await req.text();
  const v = await verificarWebhook(secreto, req.headers, cuerpo);
  if (!v.ok) return json({ error: v.motivo }, 401);

  let pago: PagoRecibido;
  try {
    pago = pagos(env).interpretarWebhook(JSON.parse(cuerpo));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const escuela = pago.metadatos.escuelaId ?? "";
  if (!ESCUELA_RE.test(escuela)) return json({ error: "metadatos.escuelaId ausente" }, 422);

  const t = tablero(env, escuela);
  const { resultado, lead, factura } = await t.aplicarPago(v.id, pago);

  // ntfy SOLO si: firma ✓ (arriba), webhook-id nuevo, y monto + referencia iguales al cobro original.
  const avisos: ResultadoNtfy[] = [];
  if (resultado.tipo === "conciliado" && lead && env.NTFY_TEMA && pago.metadatos.cobroContactoId) {
    // Cobro a un contacto: un solo push, a quien cobró (en producción también le llega por WhatsApp).
    const a = await publicarNtfy(
      env.NTFY_TEMA,
      {
        titulo: `Cobro CoDi pagado · ${lead.familia}`,
        mensaje:
          `${pesos(pago.montoMXN)} · ${pago.concepto} · Folio CoDi ${lead.pago?.folioCodi ?? "—"} · ` +
          `rastreo ${pago.claveRastreo ?? "—"} · comisión $0 · directo a la CLABE de ${beneficiarioSegunModo(env)}`,
        etiquetas: ["white_check_mark", "moneybag"],
        liga: `${new URL(req.url).origin}/?modo=contacto`,
        prioridad: 4,
      },
      { base: env.NTFY_BASE, token: env.NTFY_TOKEN },
    );
    avisos.push(a);
    await t.anotar({
      tipo: "ntfy",
      texto: `ntfy → quien cobró · ${a.status ? "HTTP " + a.status : "error: " + (a.error ?? "")}`,
      ok: a.status === 200,
    });
  } else if (resultado.tipo === "conciliado" && lead && env.NTFY_TEMA) {
    const origen = new URL(req.url).origin;
    const opciones = { base: env.NTFY_BASE, token: env.NTFY_TOKEN };
    const medio = pago.medio === "push" ? "CoDi push" : "CoDi QR";
    // 1) Al colegio: el lead ya está inscrito y pagado.
    avisos.push(
      await publicarNtfy(
        env.NTFY_TEMA,
        {
          titulo: `Colegio · ${lead.familia} inscrita y pagada`,
          mensaje: `${pesos(pago.montoMXN)} por ${medio} · ref ${pago.referencia} · comisión $0 · conciliado en el CRM`,
          etiquetas: ["white_check_mark", "school"],
          liga: `${origen}/?escuela=${escuela}`,
          prioridad: 4,
        },
        opciones,
      ),
    );
    // 2) A la familia (simulado: en producción va por WhatsApp; aquí, al mismo tema de ntfy).
    avisos.push(
      await publicarNtfy(
        env.NTFY_TEMA,
        {
          titulo: `Familia · ${beneficiarioSegunModo(env)} recibió tu pago`,
          mensaje:
            `Inscripción ${ESCUELA_DEMO.ciclo} · ${lead.grado} confirmada. ${pesos(pago.montoMXN)} sin comisión · ` +
            `Folio CoDi ${lead.pago?.folioCodi ?? "—"} · rastreo ${pago.claveRastreo ?? "—"} · desde CLABE ${pago.clabeOrdenante ?? "—"}`,
          etiquetas: ["tada", "iphone"],
          liga: `${origen}/`,
          prioridad: 3,
        },
        opciones,
      ),
    );
    for (const [i, a] of avisos.entries()) {
      await t.anotar({
        tipo: "ntfy",
        texto: `ntfy → ${i === 0 ? "colegio" : "familia"} · ${a.status ? "HTTP " + a.status : "error: " + (a.error ?? "")}`,
        ok: a.status === 200,
      });
    }
  }
  // Agente facturador: si el proveedor de timbrado falló 3 veces, se avisa al colegio (el cobro sigue pagado).
  if (factura?.tipo === "escalada" && env.NTFY_TEMA) {
    const a = await publicarNtfy(
      env.NTFY_TEMA,
      {
        titulo: "Colegio · factura sin timbrar",
        mensaje: factura.avisoColegio,
        etiquetas: ["warning", "receipt"],
        liga: `${new URL(req.url).origin}/?escuela=${escuela}`,
        prioridad: 4,
      },
      { base: env.NTFY_BASE, token: env.NTFY_TOKEN },
    );
    avisos.push(a);
  }
  return json({
    ok: true,
    webhookId: v.id,
    resultado,
    factura: factura ? { tipo: factura.tipo, uuid: "registro" in factura ? factura.registro.factura?.uuid : undefined } : undefined,
    ntfy: avisos.map((a) => ({ status: a.status, id: a.id, error: a.error })),
  });
}

/** Entrega el webhook simulado por HTTP real (service binding a este mismo Worker). */
async function entregarWebhook(env: Env, origen: string, evento: unknown): Promise<{ status: number; cuerpo: unknown; via: string }> {
  const cuerpo = JSON.stringify(evento);
  const id = "msg_demo_" + crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const firma = await firmarWebhook(env.CODI_WEBHOOK_SECRET!, id, ts, cuerpo);
  const req = new Request(`${origen}/webhooks/codi`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": firma,
    },
    body: cuerpo,
  });
  const res = env.YO ? await env.YO.fetch(req) : await webhookCodi(req, env);
  return { status: res.status, cuerpo: await res.json(), via: env.YO ? "http" : "en-proceso" };
}

// ───────────────────────── WhatsApp Flow ─────────────────────────

let llavesCache: { pem: string; privada: Promise<CryptoKey>; publica: Promise<CryptoKey> } | undefined;

function llavesFlow(env: Env) {
  const pem = env.WA_FLOW_PRIVATE_KEY;
  if (!pem || !env.WA_APP_SECRET) throw new ErrorHttp(500, "WA_FLOW_PRIVATE_KEY / WA_APP_SECRET no configurados");
  if (llavesCache?.pem !== pem) {
    const privada = importarLlavePrivada(pem);
    llavesCache = { pem, privada, publica: privada.then(llavePublicaDe) };
  }
  return { privada: llavesCache.privada, publica: llavesCache.publica, appSecret: env.WA_APP_SECRET };
}

const mins = (seg: number) => Math.round(seg / 60);

/** Lógica de negocio del Flow «Cobrar con CoDi» (ya con la firma verificada y el cuerpo descifrado). */
async function manejarFlow(s: SolicitudFlow, env: Env): Promise<Decision> {
  const token = String(s.flow_token ?? "");
  const escuela = escuelaDeFlowToken(token);
  if (!escuela) return { tokenInvalido: "Este formulario no es válido. Pide uno nuevo en el chat." };
  const t = tablero(env, escuela);
  const estado = await t.estadoFlowToken(token);
  if (!estado) return { tokenInvalido: "Este formulario ya no es válido. Pide uno nuevo en el chat." };
  if (estado !== "emitido") return { tokenInvalido: "Este cobro ya se envió." };

  const pantalla = (extra: Record<string, unknown> = {}) => ({
    respuesta: { screen: PANTALLA_COBRO, data: { ...datosPantallaCobro(), ...extra } },
  });
  if (s.action === "INIT" || s.action === "BACK") return pantalla();
  if (s.action !== "data_exchange" || s.screen !== PANTALLA_COBRO) return pantalla({ error_message: "Pantalla desconocida" });

  const f = validarFormularioCobro(s.data ?? {}, { soloFicticios: env.PAGOS_PROVEEDOR === "mock" });
  if (!f.ok) return pantalla({ error_message: f.error, campo_error: f.campo });

  if ((await t.reservarFlowToken(token)) !== "ok") return { tokenInvalido: "Este cobro ya se envió." };
  const id = "cc-" + crypto.randomUUID().slice(0, 8);
  const solicitud: SolicitudCobro = {
    montoMXN: f.montoMXN,
    concepto: f.concepto,
    referencia: nuevaReferencia(await t.todosLosCobros()),
    vigenciaSegundos: f.vigenciaSegundos,
    metadatos: { escuelaId: escuela, cobroContactoId: id },
  };
  let cobro: CobroActivo;
  try {
    // El monto confirmado es el que el negocio escribió y envió en el formulario.
    validarPoliticaCobro(solicitud, { montoConfirmadoMXN: f.montoMXN });
    const c = await pagos(env).crearCobroPush(f.contacto.celular, solicitud);
    cobro = { ...c, medio: "push", id: c.transaccionId, creadoEn: Date.now(), estado: "vigente" };
  } catch (e) {
    await t.liberarFlowToken(token);
    console.warn("No se pudo crear el cobro push del Flow", (e as Error).message);
    return pantalla({
      error_message:
        "No se pudo mandar el cobro CoDi a ese celular (¿tiene CoDi activado en su banco?). " +
        "Puedes mandarle un QR o liga de pago en el chat.",
    });
  }
  const cc: CobroContacto = {
    id,
    tipo: "contacto",
    flowToken: token,
    familia: f.contacto.nombre,
    grado: f.concepto,
    canal: "WhatsApp",
    etapa: "cobro_enviado",
    cobro,
  };
  await t.guardarCobroContacto(
    cc,
    `Flow data_exchange · X-Hub-Signature-256 ✓ · descifrado ✓ → push CoDi a ${cobro.celular} · ` +
      `${pesos(f.montoMXN)} · ref ${cobro.referencia} · vence en ${mins(f.vigenciaSegundos)} min`,
  );
  return {
    respuesta: {
      screen: "SUCCESS",
      data: {
        extension_message_response: {
          params: {
            flow_token: token,
            cobro_id: id,
            contacto: f.contacto.nombre,
            celular: cobro.celular,
            monto: f.montoMXN,
            concepto: f.concepto,
            referencia: cobro.referencia,
            folio_codi: cobro.folioCodi,
            expira_en: cobro.expiraEn,
          },
        },
      },
    },
  };
}

async function webhookFlow(req: Request, env: Env): Promise<Response> {
  const { privada, appSecret } = llavesFlow(env);
  const r = await procesarFlow(
    { cuerpo: await req.text(), firma: req.headers.get("X-Hub-Signature-256") },
    { appSecret, llavePrivada: await privada, manejar: (s) => manejarFlow(s, env) },
  );
  return new Response(r.cuerpo, {
    status: r.status,
    headers: { "Content-Type": `${r.tipo}; charset=utf-8`, "Cache-Control": "no-store" },
  });
}

/**
 * SOLO DEMO: hace lo que haría el cliente de WhatsApp al abrir/enviar el Flow:
 * cifra con la llave pública del negocio, firma como Meta y entrega por HTTP real.
 */
async function simularClienteWhatsApp(env: Env, origen: string, payload: SolicitudFlow) {
  const { publica, appSecret } = llavesFlow(env);
  const { cuerpo, llave, iv } = await cifrarComoWhatsApp(await publica, payload);
  const texto = JSON.stringify(cuerpo);
  const firma = await firmarMeta(appSecret, texto);
  const req = new Request(`${origen}/webhooks/whatsapp-flow`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firma },
    body: texto,
  });
  const res = env.YO ? await env.YO.fetch(req) : await webhookFlow(req, env);
  const respuestaTexto = await res.text();
  let respuesta: unknown;
  if (res.status === 200) respuesta = await descifrarRespuestaComoWhatsApp(respuestaTexto, llave, iv);
  else {
    try {
      respuesta = JSON.parse(respuestaTexto);
    } catch {
      respuesta = respuestaTexto;
    }
  }
  return {
    status: res.status,
    via: env.YO ? "http" : "en-proceso",
    respuesta,
    // Lo que viajó, recortado: para mostrar que iba cifrado y firmado.
    transporte: {
      "X-Hub-Signature-256": firma.slice(0, 19) + "…",
      encrypted_aes_key: cuerpo.encrypted_aes_key.slice(0, 16) + "…",
      encrypted_flow_data: cuerpo.encrypted_flow_data.slice(0, 16) + "…",
      initial_vector: bytesAB64(iv).slice(0, 8) + "…",
      respuesta_cifrada: res.status === 200 ? respuestaTexto.slice(0, 16) + "…" : undefined,
    },
  };
}

async function publicaPem(env: Env): Promise<string> {
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", await llavesFlow(env).publica)) as ArrayBuffer);
  const lineas = bytesAB64(spki).match(/.{1,64}/g) ?? [];
  return ["-----BEGIN PUBLIC KEY-----", ...lineas, "-----END PUBLIC KEY-----", ""].join("\n");
}

// ───────────────────────── API ─────────────────────────

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const ruta = url.pathname;

  if (ruta === "/api/config" && req.method === "GET") {
    const base = env.NTFY_BASE ?? "https://ntfy.sh";
    const ntfyUrl = env.NTFY_TEMA ? `${base}/${env.NTFY_TEMA}` : null;
    return json({
      proveedor: env.PAGOS_PROVEEDOR,
      escuela: { ...ESCUELA_DEMO, razonSocial: beneficiarioSegunModo(env) },
      cuota: cuotaSegunModo(env),
      pushReal: env.PAGOS_PROVEEDOR === "pey" ? Boolean(celularDestino(env, "")) : true,
      avisoPrivacidad: AVISO_PRIVACIDAD,
      ntfy: ntfyUrl
        ? { tema: env.NTFY_TEMA, servidor: base, url: ntfyUrl, qr: qrSvg(ntfyUrl) }
        : null,
      webhookConfigurado: Boolean(env.CODI_WEBHOOK_SECRET || env.PEY_WEBHOOK_SECRET_TEST),
      flowConfigurado: Boolean(env.WA_FLOW_PRIVATE_KEY && env.WA_APP_SECRET),
      contactos: CONTACTOS_DEMO.map((c) => ({ id: c.id, nombre: c.nombre, celular: enmascararCelular(c.celular) })),
      facturacion: {
        proveedor: env.FACTURACION_PROVEEDOR ?? "mock",
        webhookConfigurado: Boolean(env.FACTURACION_WEBHOOK_SECRET),
      },
      agente: {
        protocolo: "x402-codi-mxn",
        ofertaUrl: "/agente/oferta.json",
        llmsTxtUrl: "/llms.txt",
        apartarUrl: "/api/agente/apartar",
        inscripcionUrl: "/api/inscripcion",
      },
    });
  }

  if (ruta === "/api/agente/oferta.json" && req.method === "GET") {
    const escuela = validarEscuelaAgente(url.searchParams.get("escuela"));
    const { leads } = await tablero(env, escuela).estado();
    return json(construirOfertaAgente(env, url.origin, leads, escuela));
  }

  if (
    req.method === "GET" &&
    (ruta === "/api/agente/apartar" ||
      ruta === "/api/inscripcion" ||
      ruta.startsWith("/api/agente/apartar/") ||
      ruta.startsWith("/api/inscripcion/"))
  ) {
    const prefijo = ruta.startsWith("/api/agente/apartar/")
      ? "/api/agente/apartar/"
      : ruta.startsWith("/api/inscripcion/")
        ? "/api/inscripcion/"
        : "";
    const tokenPath = prefijo ? decodeURIComponent(ruta.slice(prefijo.length)) : "";
    const tokenCrudo = tokenPath || url.searchParams.get("payment_token") || url.searchParams.get("token") || "";
    if (!tokenCrudo) throw new ErrorHttp(400, "falta payment_token");
    return await consultarApartadoAgente({
      tokenCrudo,
      escuelaFallback: url.searchParams.get("escuela") ?? ESCUELA_AGENTE_DEFAULT,
      env,
      origen: url.origin,
      obtenerAlmacen: (e) => tablero(env, e),
      pagos: pagos(env),
    });
  }

  if (ruta === "/api/whatsapp-flow/llave-publica" && req.method === "GET") {
    return new Response(await publicaPem(env), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (ruta === "/api/tablero" && req.method === "GET") {
    const escuela = escuelaDe(url.searchParams.get("escuela"));
    return json(await tablero(env, escuela).estado());
  }

  if (req.method === "GET" && ruta.startsWith("/api/facturas/")) {
    const escuela = escuelaDe(url.searchParams.get("escuela"));
    const r = await rutasFacturas({
      metodo: "GET",
      ruta,
      body: {},
      escuela,
      origen: url.origin,
      almacen: tablero(env, escuela) as unknown as AlmacenFacturas,
      facturacion: crearFacturacion(env),
    });
    if (r) return r;
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const body = await leerJson(req);

  if (ruta === "/api/agente/apartar" || ruta === "/api/inscripcion") {
    return await procesarApartadoAgente({
      req,
      body,
      url,
      env,
      obtenerAlmacen: (e) => tablero(env, e),
      pagos: pagos(env),
    });
  }

  if (ruta === "/api/demo/aceptar" && !body.escuela && (body.payment_token || body.token)) {
    const { escuela: esc, busqueda } = desglosarTokenPago(String(body.payment_token ?? body.token));
    body.escuela = esc;
    body.leadId ||= busqueda;
  }

  const escuela = escuelaDe(body.escuela);
  const t = tablero(env, escuela);

  const facturas = ruta.startsWith("/api/facturas") && await rutasFacturas({
    metodo: "POST",
    ruta,
    body,
    escuela,
    origen: url.origin,
    almacen: t as unknown as AlmacenFacturas,
    facturacion: crearFacturacion(env),
  });
  if (facturas) return facturas;

  if (ruta === "/api/demo/iniciar") {
    const actual: EstadoTablero = await t.estado();
    return json(actual.leads.length && !body.reiniciar ? actual : await t.iniciar(escuela));
  }

  if (ruta === "/api/leads") {
    const lead: Lead = {
      id: "lead-" + crypto.randomUUID().slice(0, 8),
      familia: "Familia Demo (tú)",
      grado: cuotaSegunModo(env).grado,
      canal: "WhatsApp",
      etapa: "informes",
      demo: true,
    };
    // El celular es el mismo del chat de WhatsApp; aquí, uno ficticio.
    return json(await t.crearLeadDemo(lead, CELULAR_DEMO));
  }

  if (ruta === "/api/cobros") {
    const leadId = String(body.leadId ?? "");
    const medio = body.medio === "qr" ? "qr" : "push";
    const { lead, celular, leads } = await t.lead(leadId);
    if (!lead || !celular) throw new ErrorHttp(404, "lead no encontrado");
    if (lead.etapa === "pagado") throw new ErrorHttp(409, "ya está pagado");

    const p = pagos(env);
    // Antes de mandar otro cobro, confirma que el anterior no se haya pagado ya.
    if (estaVigente(lead.cobro) && (await p.estadoCobro(lead.cobro)).estado === "PAGADO") {
      throw new ErrorHttp(409, "el cobro anterior ya se pagó; espera la confirmación");
    }
    const solicitud: SolicitudCobro = {
      montoMXN: cuotaSegunModo(env).montoMXN,
      concepto: cuotaSegunModo(env).concepto,
      // Cada Mensaje de Cobro es NUEVO: referencia nueva (y folio nuevo del proveedor).
      // Un cobro vencido, rechazado o sustituido nunca se reutiliza.
      referencia: nuevaReferencia(leads),
      vigenciaSegundos: VIGENCIA_SEGUNDOS,
      metadatos: { escuelaId: escuela, leadId },
    };
    try {
      validarPoliticaCobro(solicitud, {
        // El monto que el agente le dijo a la familia y ella confirmó en el chat.
        montoConfirmadoMXN: Number(body.montoConfirmadoMXN),
        datosPrivados: [lead.familia],
      });
    } catch (e) {
      throw new ErrorHttp(422, (e as Error).message);
    }
    const ahora = Date.now();
    let cobro: CobroActivo;
    if (medio === "push") {
      // Modo pey: el push real solo va al celular de prueba (nunca al ficticio de la demo).
      const destino = celularDestino(env, celular);
      if (!destino) throw new ErrorHttp(403, "en modo pey el push solo va al celular de prueba; usa QR");
      const c = await p.crearCobroPush(destino, solicitud);
      cobro = { ...c, medio: "push", id: c.transaccionId, creadoEn: ahora };
    } else {
      const c = await p.crearCobroQR(solicitud);
      cobro = { ...c, medio: "qr", creadoEn: ahora };
    }
    await t.guardarCobro(leadId, cobro);
    return json({
      cobro,
      beneficiario: beneficiarioSegunModo(env),
      mensaje: mensajeAntesDelCobro(cobro, beneficiarioSegunModo(env)),
      avisoPrivacidad: AVISO_PRIVACIDAD,
      qrSvg: cobro.qrString ? qrSvg(cobro.qrString) : undefined,
    });
  }

  if (ruta === "/api/contactos/flow") {
    // En producción: Cloud API POST /{phone-number-id}/messages con type "interactive",
    // interactive.type "flow", flow_id y este flow_token (dentro de la ventana de 24 h del chat).
    llavesFlow(env);
    const flowToken = nuevoFlowToken(escuela);
    await t.emitirFlowToken(flowToken, escuela);
    return json({ flowToken });
  }

  if (ruta === "/api/demo/flow") {
    if (env.PAGOS_PROVEEDOR !== "mock") throw new ErrorHttp(403, "solo en modo mock");
    const flowToken = String(body.flowToken ?? "");
    if (escuelaDeFlowToken(flowToken) !== escuela) throw new ErrorHttp(400, "flow_token de otra sesión");
    const action = body.action === "INIT" ? "INIT" : "data_exchange";
    const data = typeof body.data === "object" && body.data ? (body.data as Record<string, unknown>) : {};
    return json(
      await simularClienteWhatsApp(env, url.origin, {
        version: "3.0",
        action,
        ...(action === "data_exchange" ? { screen: PANTALLA_COBRO, data } : {}),
        flow_token: flowToken,
      }),
    );
  }

  if (ruta === "/api/demo/aceptar" && body.cobroContactoId) {
    if (env.PAGOS_PROVEEDOR !== "mock") throw new ErrorHttp(403, "solo en modo mock");
    if (!env.CODI_WEBHOOK_SECRET) throw new ErrorHttp(500, "CODI_WEBHOOK_SECRET no configurado");
    const cc = await t.cobroContacto(String(body.cobroContactoId));
    if (!cc?.cobro) throw new ErrorHttp(404, "cobro no encontrado");
    if (cc.etapa === "pagado") throw new ErrorHttp(409, "ya está pagado");
    if (!estaVigente(cc.cobro)) throw new ErrorHttp(409, "el cobro ya no está vigente");
    const evento = new PagosCoDiMock().simularAceptacion(cc.cobro, { escuelaId: escuela, cobroContactoId: cc.id });
    return json({ webhook: await entregarWebhook(env, url.origin, evento) });
  }

  if (ruta === "/api/demo/aceptar") {
    if (env.PAGOS_PROVEEDOR !== "mock") throw new ErrorHttp(403, "solo en modo mock");
    if (!env.CODI_WEBHOOK_SECRET) throw new ErrorHttp(500, "CODI_WEBHOOK_SECRET no configurado");
    const { lead } = await t.lead(String(body.leadId ?? ""));
    if (!lead?.cobro) throw new ErrorHttp(404, "no hay cobro vigente");
    if (!estaVigente(lead.cobro)) throw new ErrorHttp(409, "el cobro ya no está vigente");
    const evento = new PagosCoDiMock().simularAceptacion(lead.cobro, { escuelaId: escuela, leadId: lead.id });
    return json({ webhook: await entregarWebhook(env, url.origin, evento) });
  }

  // ───────── agente de cobranza: colegiatura del mes (demo con reloj a mano) ─────────
  if (ruta.startsWith("/api/demo/colegiatura")) {
    if (env.PAGOS_PROVEEDOR !== "mock") throw new ErrorHttp(403, "solo en modo mock");
    const id = String(body.colegiaturaId ?? "");
    if (ruta === "/api/demo/colegiaturas") {
      // La colegiatura del mes siguiente (hora CDMX), para que todo el calendario quede por delante.
      const hoy = new Date(Date.now() - 6 * 3600 * 1000);
      const mes = (hoy.getUTCMonth() + 1) % 12 + 1;
      const anio = hoy.getUTCFullYear() + (mes === 1 ? 1 : 0);
      return json(await t.iniciarColegiaturas(anio, mes));
    }
    if (ruta === "/api/demo/colegiatura/avanzar") {
      const r = await t.avanzarColegiatura(id);
      if (!r.colegiatura) throw new ErrorHttp(404, "colegiatura no encontrada");
      return json(r);
    }
    if (ruta === "/api/demo/colegiatura/activar-codi") {
      const c = await t.activarCodiColegiatura(id);
      if (!c) throw new ErrorHttp(404, "colegiatura no encontrada");
      return json({ colegiatura: c });
    }
    if (ruta === "/api/demo/colegiatura/aceptar") {
      if (!env.CODI_WEBHOOK_SECRET) throw new ErrorHttp(500, "CODI_WEBHOOK_SECRET no configurado");
      const u = await t.ultimoCobroColegiatura(id);
      if (!u) throw new ErrorHttp(404, "colegiatura no encontrada");
      if (u.pagada) throw new ErrorHttp(409, "ya está pagada");
      if (!u.cobro?.id) throw new ErrorHttp(409, "todavía no hay cobro CoDi de esta colegiatura");
      const { id: cobroId, montoMXN, referencia, concepto = "" } = u.cobro;
      const evento = new PagosCoDiMock().simularAceptacion(
        { medio: "push", id: cobroId, montoMXN, concepto, referencia },
        { escuelaId: escuela, colegiaturaId: id },
      );
      return json({ webhook: await entregarWebhook(env, url.origin, evento) });
    }
  }

  if (ruta === "/api/demo/vencer") {
    if (env.PAGOS_PROVEEDOR !== "mock") throw new ErrorHttp(403, "solo en modo mock");
    const { lead } = await t.lead(String(body.leadId ?? ""));
    if (!estaVigente(lead?.cobro)) throw new ErrorHttp(404, "no hay cobro vigente");
    return json(await t.vencerAhora(lead!.id));
  }

  return json({ error: "No encontrado" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/webhooks/codi") {
        return req.method === "POST" ? await webhookCodi(req, env) : json({ error: "Usa POST" }, 405);
      }
      if (url.pathname === "/webhooks/facturacion") {
        if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
        return await webhookFacturacion(req, {
          secreto: await secretoWebhookFacturacion(env),
          obtenerAlmacen: (e) => tablero(env, e) as unknown as AlmacenFacturas,
          escuelaValida: (e) => ESCUELA_RE.test(e),
        });
      }
      if (url.pathname === "/webhooks/whatsapp-flow") {
        return req.method === "POST" ? await webhookFlow(req, env) : json({ error: "Usa POST" }, 405);
      }
      if (url.pathname === "/agente/oferta.json") {
        if (req.method !== "GET") return json({ error: "Usa GET" }, 405);
        const escuela = validarEscuelaAgente(url.searchParams.get("escuela"));
        const { leads } = await tablero(env, escuela).estado();
        return json(construirOfertaAgente(env, url.origin, leads, escuela));
      }
      if (url.pathname === "/llms.txt") {
        if (req.method !== "GET") return json({ error: "Usa GET" }, 405);
        const escuela = validarEscuelaAgente(url.searchParams.get("escuela"));
        const { leads } = await tablero(env, escuela).estado();
        return new Response(construirLlmsTxt(env, url.origin, leads), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      const status = e instanceof ErrorHttp ? e.status : 500;
      return json({ error: (e as Error).message }, status);
    }
  },
} satisfies ExportedHandler<Env>;
