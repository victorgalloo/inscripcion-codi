/**
 * Agente facturador (tercer agente, Victor 26-nov-2026).
 *
 * Cadena: adopción (src/activacion.ts) → cobranza (src/cobranza.ts) → conciliación
 * (src/conciliacion.ts) → FACTURA. En cuanto la conciliación marca un cobro como pagado,
 * este agente arma y timbra solo el CFDI 4.0 de ingreso de esa inscripción o colegiatura
 * y se lo entrega a la familia por WhatsApp. Nadie la pide ni la captura.
 *
 *   - Un pago = una factura: la llave es el id de la transacción CoDi. Si el webhook llega
 *     dos veces, o el colegio la pide a mano, no se timbra de nuevo.
 *   - Sin datos fiscales → público en general, y el mensaje ofrece cambiarla a nombre de la
 *     familia dentro del mes. Con los datos: se timbra la nueva relacionada (tipo 04) y se
 *     cancela la anterior con motivo 01 y el folio de la nueva (orden que pide el SAT).
 *   - Si el proveedor falla: reintento con espera creciente; al tercer fallo, aviso al
 *     colegio. El cobro NUNCA se revierte por un fallo de factura.
 *
 * Agnóstico de proveedor: solo habla con la interfaz `Facturacion`. El almacenamiento
 * entra por `RepoFacturas` (Durable Object en producción, memoria en las pruebas).
 */
import type { Lead } from "./conciliacion.ts";
import { OFFSET_CDMX_SEG } from "./cobranza.ts";
import type { ConfigFacturador } from "./facturacion/fabrica.ts";
import {
  CLAVE_PROD_SERV_SIN_CONFIGURAR,
  CLAVE_UNIDAD_SERVICIO,
  FORMA_PAGO_TRANSFERENCIA,
  NOMBRE_PUBLICO_EN_GENERAL,
  REGIMEN_PUBLICO_EN_GENERAL,
  RFC_PUBLICO_EN_GENERAL,
  USO_PUBLICO_EN_GENERAL,
  centavos,
  validarCancelacion,
  validarDatosFiscales,
  type ComplementoIEDU,
  type DatosFiscales,
  type EventoFactura,
  type Factura,
  type Facturacion,
  type NivelEducativo,
  type RegistroFactura,
  type SolicitudCancelacion,
  type SolicitudFactura,
} from "./facturacion/tipos.ts";
import { avisoFacturaAlColegio, mensajeFacturaLista, mensajeFacturaSustituida } from "./mensajes.ts";

export const MAX_INTENTOS = 3;
/** Espera antes del 2.º y del 3.er intento: creciente. */
export const ESPERAS_MS: readonly number[] = [1000, 3000];

/** Lo que hace falta de un pago conciliado para facturarlo. */
export interface PagoAFacturar {
  /** Llave de idempotencia: id de la transacción CoDi. */
  llave: string;
  leadId: string;
  escuelaId: string;
  montoMXN: number;
  /** Concepto del cobro (ya sin datos personales: sale del catálogo de cuotas). */
  descripcion: string;
  nivel?: NivelEducativo;
  /** Unix (s). */
  pagadoEn: number;
}

/** Nivel educativo a partir del grado del lead («1° primaria», «Kínder 2», …). */
export function nivelDeGrado(grado: string): NivelEducativo | undefined {
  const g = grado.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/kinder|preescolar|maternal/.test(g)) return "Preescolar";
  if (/primaria/.test(g)) return "Primaria";
  if (/secundaria/.test(g)) return "Secundaria";
  if (/prepa|bachillerato/.test(g)) return "Bachillerato o su equivalente";
  return undefined;
}

export function pagoDeLead(lead: Lead, escuelaId: string): PagoAFacturar | undefined {
  if (lead.etapa !== "pagado" || !lead.pago) return undefined;
  return {
    llave: lead.pago.transaccionId,
    leadId: lead.id,
    escuelaId,
    montoMXN: lead.pago.montoMXN,
    descripcion: lead.cobro?.concepto ?? `Servicios educativos ${lead.grado}`,
    nivel: nivelDeGrado(lead.grado),
    pagadoEn: lead.pago.pagadoEn,
  };
}

/** Último segundo del mes (hora del centro) en que se emitió: plazo para pedirla a su nombre. */
export function finDelMesCdmx(unix: number): number {
  const local = new Date((unix + OFFSET_CDMX_SEG) * 1000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) / 1000 - OFFSET_CDMX_SEG - 1;
}

/** Arma el CFDI 4.0 de ingreso: público en general si no hay datos fiscales; IVA exento. */
export function armarSolicitudFactura(
  p: PagoAFacturar,
  config: ConfigFacturador,
  opciones: { datosFiscales?: DatosFiscales; iedu?: ComplementoIEDU; sustituye?: string; llave?: string } = {},
): SolicitudFactura {
  const { emisor } = config;
  if (opciones.datosFiscales) validarDatosFiscales(opciones.datosFiscales);
  const publico = !opciones.datosFiscales;
  const receptor: DatosFiscales = opciones.datosFiscales ?? {
    rfc: RFC_PUBLICO_EN_GENERAL,
    nombre: NOMBRE_PUBLICO_EN_GENERAL,
    // Con RFC genérico, el domicilio fiscal del receptor es el lugar de expedición.
    codigoPostal: emisor.codigoPostal,
    regimenFiscal: REGIMEN_PUBLICO_EN_GENERAL,
    usoCfdi: USO_PUBLICO_EN_GENERAL,
  };
  const importe = centavos(p.montoMXN);
  if (!(importe > 0)) throw new Error("El importe a facturar debe ser mayor que 0");
  const claveProdServ = (p.nivel && config.claves[p.nivel]) || CLAVE_PROD_SERV_SIN_CONFIGURAR;
  const local = new Date((p.pagadoEn + OFFSET_CDMX_SEG) * 1000);
  return {
    llave: opciones.llave ?? p.llave,
    tipoComprobante: "I",
    exportacion: "01",
    moneda: "MXN",
    formaPago: FORMA_PAGO_TRANSFERENCIA,
    metodoPago: "PUE",
    lugarExpedicion: emisor.codigoPostal,
    fechaPago: p.pagadoEn,
    emisor,
    receptor,
    publicoEnGeneral: publico,
    ...(publico
      ? {
          informacionGlobal: {
            periodicidad: "01" as const,
            meses: String(local.getUTCMonth() + 1).padStart(2, "0"),
            anio: local.getUTCFullYear(),
          },
        }
      : {}),
    conceptos: [
      {
        claveProdServ,
        claveUnidad: CLAVE_UNIDAD_SERVICIO,
        cantidad: 1,
        descripcion: p.descripcion,
        valorUnitario: importe,
        importe,
        objetoImp: "02",
        // Ley del IVA, art. 15, fracc. IV: enseñanza con validez oficial, exenta.
        traslado: { impuesto: "002", tipoFactor: "Exento", base: importe },
        ...(opciones.iedu ? { iedu: opciones.iedu } : {}),
      },
    ],
    subtotal: importe,
    total: importe, // exento: no se suma IVA
    ...(opciones.sustituye ? { cfdiRelacionados: { tipoRelacion: "04" as const, uuids: [opciones.sustituye] } } : {}),
    metadatos: { escuelaId: p.escuelaId, leadId: p.leadId, pago: p.llave },
  };
}

export type Decision = "facturar" | "ya_facturada" | "no_pagado" | "en_error";

/** ¿Hay que timbrar? Un pago = una factura (llave = transacción). */
export function decidirFacturacion(lead: Lead | undefined): Decision {
  if (!lead || lead.etapa !== "pagado" || !lead.pago) return "no_pagado";
  const r = lead.factura;
  if (!r || r.llave !== lead.pago.transaccionId) return "facturar";
  return r.estado === "error" || r.estado === "rechazada" ? "en_error" : "ya_facturada";
}

const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const esReintentable = (e: unknown) => (e as { reintentable?: boolean }).reintentable === true;

/** Timbra con reintentos (solo si el error es reintentable). */
export async function timbrarConReintentos(
  facturacion: Facturacion,
  s: SolicitudFactura,
  esperar: (ms: number) => Promise<void> = espera,
): Promise<{ ok: true; factura: Factura; intentos: number } | { ok: false; error: string; intentos: number }> {
  let intentos = 0;
  for (;;) {
    intentos++;
    try {
      return { ok: true, factura: await facturacion.emitir(s), intentos };
    } catch (e) {
      if (!esReintentable(e) || intentos >= MAX_INTENTOS) return { ok: false, error: (e as Error).message, intentos };
      await esperar(ESPERAS_MS[intentos - 1] ?? ESPERAS_MS[ESPERAS_MS.length - 1]!);
    }
  }
}

// ───────────────────────── el agente sobre un almacén ─────────────────────────

/** Persistencia mínima que necesita el agente (Durable Object `Tablero` o memoria). */
export interface RepoFacturas {
  leads(): Promise<Lead[]>;
  guardarRegistro(leadId: string, registro: RegistroFactura): Promise<void>;
  anotar(texto: string, ok: boolean): Promise<void>;
}

export interface ContextoFacturador {
  repo: RepoFacturas;
  facturacion: Facturacion;
  config: ConfigFacturador;
  escuelaId: string;
  esperar?: (ms: number) => Promise<void>;
  ahora?: () => number;
}

export type ResultadoFacturador =
  | { tipo: "timbrada" | "pendiente" | "ya_facturada"; leadId: string; registro: RegistroFactura }
  | { tipo: "escalada"; leadId: string; registro: RegistroFactura; avisoColegio: string }
  | { tipo: "no_pagado"; leadId: string };

const datosMensaje = (f: Factura) => ({
  descripcion: f.conceptos[0]?.descripcion ?? "servicios educativos",
  total: f.total,
  uuid: f.uuid,
  publicoEnGeneral: f.publicoEnGeneral,
  receptor: f.receptor.nombre,
});

/**
 * Factura el pago conciliado de un lead. Lo llama el tablero al conciliar (webhook CoDi,
 * «aceptar» de la demo, consulta al vencer) y la ruta POST /api/facturas.
 */
export async function facturarLead(
  ctx: ContextoFacturador,
  leadId: string,
  opciones: { datosFiscales?: DatosFiscales; iedu?: ComplementoIEDU; reintentar?: boolean } = {},
): Promise<ResultadoFacturador> {
  const lead = (await ctx.repo.leads()).find((l) => l.id === leadId);
  const decision = decidirFacturacion(lead);
  if (decision === "no_pagado" || !lead) return { tipo: "no_pagado", leadId };
  if (decision === "ya_facturada") return { tipo: "ya_facturada", leadId, registro: lead.factura! };
  if (decision === "en_error" && !opciones.reintentar) return { tipo: "ya_facturada", leadId, registro: lead.factura! };

  const pago = pagoDeLead(lead, ctx.escuelaId)!;
  const solicitud = armarSolicitudFactura(pago, ctx.config, opciones);
  // Marca ANTES de llamar al proveedor: un webhook repetido mientras tanto ya no timbra otra.
  await ctx.repo.guardarRegistro(leadId, { llave: pago.llave, estado: "timbrando", intentos: 0 });

  const r = await timbrarConReintentos(ctx.facturacion, solicitud, ctx.esperar);
  if (!r.ok) {
    const registro: RegistroFactura = { llave: pago.llave, estado: "error", intentos: r.intentos, error: r.error };
    await ctx.repo.guardarRegistro(leadId, registro);
    const avisoColegio = avisoFacturaAlColegio(lead.familia, pago.montoMXN, r.intentos, r.error);
    await ctx.repo.anotar(`Factura · ${avisoColegio}`, false);
    return { tipo: "escalada", leadId, registro, avisoColegio };
  }
  const f = r.factura;
  const hasta = f.publicoEnGeneral ? finDelMesCdmx(f.emitidaEn) : undefined;
  const registro: RegistroFactura = {
    llave: pago.llave,
    estado: f.estado,
    factura: f,
    intentos: r.intentos,
    ...(hasta ? { datosFiscalesHasta: hasta } : {}),
    // Si quedó pendiente, el mensaje se manda cuando el proveedor avise que se timbró.
    ...(f.estado === "timbrada" ? { mensajeFamilia: mensajeFacturaLista(datosMensaje(f), hasta) } : {}),
  };
  await ctx.repo.guardarRegistro(leadId, registro);
  await ctx.repo.anotar(
    `Factura CFDI 4.0 ${f.estado} · ${f.publicoEnGeneral ? "público en general" : f.receptor.rfc} · ` +
      `${f.total.toFixed(2)} MXN IVA exento · UUID ${f.uuid ?? "pendiente"}${r.intentos > 1 ? ` · ${r.intentos} intentos` : ""}`,
    f.estado !== "rechazada",
  );
  if (f.estado === "rechazada") {
    const avisoColegio = avisoFacturaAlColegio(lead.familia, pago.montoMXN, r.intentos, f.motivoRechazo ?? "rechazada");
    return { tipo: "escalada", leadId, registro: { ...registro, error: f.motivoRechazo }, avisoColegio };
  }
  return { tipo: f.estado === "timbrada" ? "timbrada" : "pendiente", leadId, registro };
}

export type ResultadoSustitucion =
  | { tipo: "sustituida"; leadId: string; registro: RegistroFactura; mensajeFamilia: string }
  | { tipo: "sin_factura" | "fuera_de_plazo" | "pendiente_de_timbre"; leadId: string }
  | { tipo: "error"; leadId: string; error: string };

/**
 * La familia mandó sus datos fiscales: se timbra la nueva (relacionada, tipo 04) y se
 * cancela la de público en general con motivo 01 y el folio de la nueva.
 * Si todavía no había factura, simplemente se emite ya a su nombre.
 */
export async function sustituirConDatosFiscales(
  ctx: ContextoFacturador,
  leadId: string,
  datos: DatosFiscales,
  iedu?: ComplementoIEDU,
): Promise<ResultadoSustitucion | ResultadoFacturador> {
  validarDatosFiscales(datos);
  const lead = (await ctx.repo.leads()).find((l) => l.id === leadId);
  const decision = decidirFacturacion(lead);
  if (decision === "no_pagado" || !lead) return { tipo: "no_pagado", leadId };
  if (decision === "facturar" || decision === "en_error") {
    return facturarLead(ctx, leadId, { datosFiscales: datos, iedu, reintentar: true });
  }
  const previo = lead.factura!;
  const anterior = previo.factura;
  if (!anterior || previo.estado !== "timbrada") return { tipo: "sin_factura", leadId };
  if (!anterior.uuid) return { tipo: "pendiente_de_timbre", leadId };
  const ahora = ctx.ahora?.() ?? Math.floor(Date.now() / 1000);
  if (ahora > (previo.datosFiscalesHasta ?? finDelMesCdmx(anterior.emitidaEn))) return { tipo: "fuera_de_plazo", leadId };

  const n = (previo.anteriores?.length ?? 0) + 1;
  const solicitud = armarSolicitudFactura(pagoDeLead(lead, ctx.escuelaId)!, ctx.config, {
    datosFiscales: datos,
    iedu,
    sustituye: anterior.uuid,
    llave: `${previo.llave}-sust${n}`,
  });
  const r = await timbrarConReintentos(ctx.facturacion, solicitud, ctx.esperar);
  if (!r.ok) {
    await ctx.repo.anotar(`Factura · no se pudo timbrar la sustitución: ${r.error}`, false);
    return { tipo: "error", leadId, error: r.error };
  }
  const nueva = r.factura;
  if (!nueva.uuid) return { tipo: "pendiente_de_timbre", leadId };

  let cancelada: Factura = anterior;
  let error: string | undefined;
  try {
    cancelada = await ctx.facturacion.cancelar(anterior.id, { motivo: "01", folioSustitucion: nueva.uuid });
    cancelada = { ...anterior, ...cancelada };
  } catch (e) {
    error = `Falta cancelar ${anterior.uuid} con motivo 01: ${(e as Error).message}`;
  }
  const mensajeFamilia = mensajeFacturaSustituida(datosMensaje(nueva));
  const registro: RegistroFactura = {
    llave: previo.llave,
    estado: nueva.estado,
    factura: nueva,
    anteriores: [...(previo.anteriores ?? []), cancelada],
    intentos: r.intentos,
    mensajeFamilia,
    ...(error ? { error } : {}),
  };
  await ctx.repo.guardarRegistro(leadId, registro);
  await ctx.repo.anotar(
    `Factura sustituida · ${nueva.receptor.rfc} · UUID ${nueva.uuid} (relación 04) · anterior ${anterior.uuid} ` +
      (error ? "· cancelación pendiente" : "cancelada con motivo 01"),
    !error,
  );
  return { tipo: "sustituida", leadId, registro, mensajeFamilia };
}

/** Busca una factura (vigente o anterior) por id del proveedor. */
export function buscarFactura(leads: Lead[], id: string): { lead: Lead; factura: Factura } | undefined {
  for (const lead of leads) {
    const r = lead.factura;
    const f = r?.factura?.id === id ? r.factura : r?.anteriores?.find((a) => a.id === id);
    if (f) return { lead, factura: f };
  }
  return undefined;
}

/** Cancelación a mano (motivo 02, 03 o 04; o 01 con el folio que la sustituye). */
export async function cancelarFactura(
  ctx: ContextoFacturador,
  facturaId: string,
  c: SolicitudCancelacion,
): Promise<{ leadId: string; factura: Factura } | undefined> {
  validarCancelacion(c);
  const hallada = buscarFactura(await ctx.repo.leads(), facturaId);
  if (!hallada) return undefined;
  const r = hallada.lead.factura!;
  if (hallada.factura.estado === "cancelada") return { leadId: hallada.lead.id, factura: hallada.factura };
  const cancelada = { ...hallada.factura, ...(await ctx.facturacion.cancelar(facturaId, c)) };
  const vigente = r.factura?.id === facturaId;
  await ctx.repo.guardarRegistro(hallada.lead.id, {
    ...r,
    ...(vigente ? { factura: cancelada, estado: cancelada.estado } : {}),
    anteriores: vigente ? r.anteriores : r.anteriores?.map((a) => (a.id === facturaId ? cancelada : a)),
  });
  await ctx.repo.anotar(`Factura ${cancelada.uuid ?? facturaId} cancelada · motivo ${c.motivo}`, true);
  return { leadId: hallada.lead.id, factura: cancelada };
}

/** Webhook del proveedor (timbrada / cancelada / rechazada) sobre la factura guardada. */
export async function aplicarEventoFactura(
  repo: RepoFacturas,
  evento: EventoFactura,
): Promise<{ tipo: "actualizada"; leadId: string; registro: RegistroFactura } | { tipo: "sin_factura" }> {
  const hallada = buscarFactura(await repo.leads(), evento.factura.id);
  if (!hallada) return { tipo: "sin_factura" };
  const r = hallada.lead.factura!;
  const f: Factura = { ...hallada.factura, ...evento.factura };
  let registro: RegistroFactura;
  if (r.factura?.id === f.id) {
    const recienTimbrada = f.estado === "timbrada" && r.estado !== "timbrada";
    const hasta = f.publicoEnGeneral ? finDelMesCdmx(f.emitidaEn) : undefined;
    registro = {
      ...r,
      factura: f,
      estado: f.estado,
      ...(recienTimbrada && hasta ? { datosFiscalesHasta: hasta } : {}),
      ...(recienTimbrada ? { mensajeFamilia: mensajeFacturaLista(datosMensaje(f), hasta) } : {}),
      ...(f.estado === "rechazada" ? { error: f.motivoRechazo ?? "rechazada por el proveedor" } : {}),
    };
  } else {
    registro = { ...r, anteriores: r.anteriores?.map((a) => (a.id === f.id ? f : a)) };
  }
  await repo.guardarRegistro(hallada.lead.id, registro);
  await repo.anotar(`Webhook ${evento.tipo} · UUID ${f.uuid ?? "—"}`, evento.tipo !== "factura.rechazada");
  return { tipo: "actualizada", leadId: hallada.lead.id, registro };
}

/** Repo en memoria (pruebas). */
export function repoMemoria(leadsIniciales: Lead[]): RepoFacturas & { bitacora: { texto: string; ok: boolean }[]; actuales(): Lead[] } {
  let leads = structuredClone(leadsIniciales);
  const bitacora: { texto: string; ok: boolean }[] = [];
  return {
    bitacora,
    actuales: () => leads,
    async leads() {
      return structuredClone(leads);
    },
    async guardarRegistro(leadId, registro) {
      leads = leads.map((l) => (l.id === leadId ? { ...l, factura: structuredClone(registro) } : l));
    },
    async anotar(texto, ok) {
      bitacora.push({ texto, ok });
    },
  };
}
