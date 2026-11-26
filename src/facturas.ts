/**
 * Endpoints propios de facturación (estables y agnósticos de proveedor):
 *
 *   POST /api/facturas                     emitir a mano (o reintentar) la factura del pago de un lead;
 *                                          con datosFiscales: re-facturar a nombre de la familia
 *   GET  /api/facturas/:id                 la factura guardada (y su estado)
 *   GET  /api/facturas/:id/pdf | /xml      archivos (el mock arma una muestra «SIMULADO»)
 *   POST /api/facturas/:id/cancelar        cancelar con motivo SAT (01 exige folioSustitucion)
 *   POST /api/facturas/datos-fiscales      la familia entrega RFC, nombre, CP, régimen y uso → sustitución
 *   POST /webhooks/facturacion             el proveedor avisa timbrada / cancelada / rechazada
 *                                          (Standard Webhooks, HMAC-SHA256 con FACTURACION_WEBHOOK_SECRET)
 *
 * Toda la lógica vive en el agente facturador (src/facturador.ts); aquí solo se traduce HTTP.
 * El almacén es el Durable Object `Tablero` (o uno en memoria en las pruebas).
 */
import type {
  ComplementoIEDU,
  DatosFiscales,
  EventoFactura,
  Factura,
  Facturacion,
  NivelEducativo,
  RegistroFactura,
  SolicitudCancelacion,
} from "./facturacion/tipos.ts";
import { datosFiscalesDe, interpretarEventoFactura } from "./facturacion/tipos.ts";
import type { ConfigFacturador } from "./facturacion/fabrica.ts";
import {
  aplicarEventoFactura,
  buscarFactura,
  cancelarFactura,
  facturarLead,
  repoMemoria,
  sustituirConDatosFiscales,
  type ContextoFacturador,
  type ResultadoFacturador,
  type ResultadoSustitucion,
} from "./facturador.ts";
import { verificarWebhook } from "./webhooks.ts";
import type { Lead } from "./conciliacion.ts";

/** Lo que el Durable Object `Tablero` expone para facturación. */
export interface AlmacenFacturas {
  facturar(
    leadId: string,
    opciones?: { datosFiscales?: DatosFiscales; iedu?: ComplementoIEDU; reintentar?: boolean },
  ): Promise<ResultadoFacturador>;
  sustituirFactura(leadId: string, datos: DatosFiscales, iedu?: ComplementoIEDU): Promise<ResultadoSustitucion | ResultadoFacturador>;
  cancelarFactura(id: string, c: SolicitudCancelacion): Promise<{ leadId: string; factura: Factura } | undefined>;
  factura(id: string): Promise<{ leadId: string; factura: Factura; registro: RegistroFactura } | undefined>;
  eventoFactura(
    webhookId: string,
    evento: EventoFactura,
  ): Promise<{ tipo: "actualizada"; leadId: string; registro: RegistroFactura } | { tipo: "sin_factura" | "duplicado" }>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const NIVELES: readonly NivelEducativo[] = ["Preescolar", "Primaria", "Secundaria", "Profesional técnico", "Bachillerato o su equivalente"];

/** Complemento IEDU opcional. Viaja al proveedor y no se guarda. */
export function ieduDe(v: unknown): ComplementoIEDU | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const curp = String(o.CURP ?? o.curp ?? "").trim().toUpperCase();
  const nivel = String(o.nivelEducativo ?? "") as NivelEducativo;
  const nombre = String(o.nombreAlumno ?? "").trim();
  const rvoe = String(o.autRVOE ?? o.rvoe ?? "").trim();
  if (!nombre) throw new Error("IEDU: falta el nombre del alumno");
  if (!/^[A-Z]{4}[0-9]{6}[HMX][A-Z]{5}[A-Z0-9][0-9]$/.test(curp)) throw new Error("IEDU: CURP inválida");
  if (!NIVELES.includes(nivel)) throw new Error("IEDU: nivel educativo inválido");
  if (!rvoe) throw new Error("IEDU: falta la clave de validez oficial (autRVOE)");
  return {
    version: "1.0",
    nombreAlumno: nombre,
    CURP: curp,
    nivelEducativo: nivel,
    autRVOE: rvoe,
    ...(o.rfcPago ? { rfcPago: String(o.rfcPago).toUpperCase() } : {}),
  };
}

/** Nuestras ligas estables (nunca las del proveedor): el Worker sirve o reenvía el archivo. */
export function ligasFactura(origen: string, escuela: string, id: string) {
  const q = `?escuela=${encodeURIComponent(escuela)}`;
  const base = `${origen}/api/facturas/${encodeURIComponent(id)}`;
  return { factura: base + q, pdf: `${base}/pdf${q}`, xml: `${base}/xml${q}` };
}

function respuestaResultado(r: ResultadoSustitucion | ResultadoFacturador, origen: string, escuela: string): Response {
  const f = "registro" in r ? r.registro.factura : undefined;
  const cuerpo = { resultado: r, ...(f ? { ligas: ligasFactura(origen, escuela, f.id) } : {}) };
  switch (r.tipo) {
    case "timbrada":
    case "sustituida":
      return json(cuerpo, 201);
    case "pendiente":
      return json(cuerpo, 202);
    case "ya_facturada":
      return json(cuerpo, 200);
    case "escalada":
    case "error":
      return json(cuerpo, 502); // el cobro sigue pagado; el colegio ya fue avisado
    case "no_pagado":
      return json({ error: "el lead no tiene un pago conciliado", resultado: r }, 409);
    case "fuera_de_plazo":
      return json({ error: "el plazo para cambiar la factura (fin del mes de emisión) ya pasó", resultado: r }, 409);
    case "pendiente_de_timbre":
      return json({ error: "la factura aún no tiene folio fiscal; intenta en unos minutos", resultado: r }, 409);
    default:
      return json({ error: "sin factura que sustituir", resultado: r }, 409);
  }
}

/** Atiende /api/facturas*. `undefined` = la ruta no es de facturación. */
export async function rutasFacturas(o: {
  metodo: string;
  ruta: string;
  body: Record<string, unknown>;
  escuela: string;
  origen: string;
  almacen: AlmacenFacturas;
  facturacion: Facturacion;
}): Promise<Response | undefined> {
  const { metodo, ruta, body, escuela, origen, almacen, facturacion } = o;
  if (ruta !== "/api/facturas" && !ruta.startsWith("/api/facturas/")) return undefined;

  try {
    if (ruta === "/api/facturas" && metodo === "POST") {
      const leadId = String(body.leadId ?? "");
      if (!leadId) return json({ error: "falta leadId" }, 400);
      const iedu = ieduDe(body.iedu);
      const fiscales = body.datosFiscales ? datosFiscalesDe(body.datosFiscales as Record<string, unknown>) : undefined;
      const r = fiscales
        ? await almacen.sustituirFactura(leadId, fiscales, iedu)
        : await almacen.facturar(leadId, { iedu, reintentar: true });
      return respuestaResultado(r, origen, escuela);
    }

    if (ruta === "/api/facturas/datos-fiscales" && metodo === "POST") {
      const leadId = String(body.leadId ?? "");
      if (!leadId) return json({ error: "falta leadId" }, 400);
      const r = await almacen.sustituirFactura(leadId, datosFiscalesDe(body), ieduDe(body.iedu));
      return respuestaResultado(r, origen, escuela);
    }

    const m = /^\/api\/facturas\/([^/]+)(?:\/(pdf|xml|cancelar))?$/.exec(ruta);
    if (!m) return json({ error: "No encontrado" }, 404);
    const id = decodeURIComponent(m[1]!);
    const accion = m[2];

    if (accion === "cancelar") {
      if (metodo !== "POST") return json({ error: "Usa POST" }, 405);
      const c: SolicitudCancelacion = {
        motivo: String(body.motivo ?? "") as SolicitudCancelacion["motivo"],
        ...(body.folioSustitucion ? { folioSustitucion: String(body.folioSustitucion) } : {}),
      };
      const r = await almacen.cancelarFactura(id, c);
      return r ? json(r) : json({ error: "factura no encontrada" }, 404);
    }

    if (metodo !== "GET") return json({ error: "Usa GET" }, 405);
    const hallada = await almacen.factura(id);
    if (!hallada) return json({ error: "factura no encontrada" }, 404);
    if (!accion) return json({ ...hallada, ligas: ligasFactura(origen, escuela, id) });

    const a = await facturacion.archivo(hallada.factura, accion as "pdf" | "xml");
    const nombre = `factura-${hallada.factura.uuid ?? id}.${accion}`;
    return new Response(a.cuerpo as BodyInit, {
      headers: { "Content-Type": a.tipo, "Content-Disposition": `inline; filename="${nombre}"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    // Errores del proveedor → 502; validaciones (RFC, CP, motivo, IEDU…) → 422.
    return json({ error: (e as Error).message }, typeof status === "number" ? 502 : 422);
  }
}

/** POST /webhooks/facturacion: firma → evento canónico → tablero de la escuela. */
export async function webhookFacturacion(
  req: Request,
  o: {
    secreto?: string;
    obtenerAlmacen: (escuela: string) => AlmacenFacturas;
    escuelaValida: (e: string) => boolean;
    ahora?: number;
  },
): Promise<Response> {
  if (!o.secreto) return json({ error: "FACTURACION_WEBHOOK_SECRET no configurado" }, 500);
  const cuerpo = await req.text();
  const v = await verificarWebhook(o.secreto, req.headers, cuerpo, o.ahora);
  if (!v.ok) return json({ error: v.motivo }, 401);
  let evento: EventoFactura;
  try {
    evento = interpretarEventoFactura(JSON.parse(cuerpo));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const escuela = evento.factura.metadatos.escuelaId ?? "";
  if (!o.escuelaValida(escuela)) return json({ error: "metadatos.escuelaId ausente" }, 422);
  const resultado = await o.obtenerAlmacen(escuela).eventoFactura(v.id, evento);
  return json({ ok: true, webhookId: v.id, resultado });
}

/** Almacén en memoria con la misma lógica que el `Tablero` (pruebas en Node). */
export function crearAlmacenFacturasMemoria(
  leads: Lead[],
  facturacion: Facturacion,
  config: ConfigFacturador,
  escuelaId: string,
  extra: Partial<Pick<ContextoFacturador, "esperar" | "ahora">> = {},
): AlmacenFacturas & { repo: ReturnType<typeof repoMemoria> } {
  const repo = repoMemoria(leads);
  const ctx: ContextoFacturador = { repo, facturacion, config, escuelaId, ...extra };
  const webhooks = new Set<string>();
  return {
    repo,
    facturar: (leadId, opciones) => facturarLead(ctx, leadId, opciones),
    sustituirFactura: (leadId, datos, iedu) => sustituirConDatosFiscales(ctx, leadId, datos, iedu),
    cancelarFactura: (id, c) => cancelarFactura(ctx, id, c),
    async factura(id) {
      const h = buscarFactura(await repo.leads(), id);
      return h ? { leadId: h.lead.id, factura: h.factura, registro: h.lead.factura! } : undefined;
    },
    async eventoFactura(webhookId, evento) {
      if (webhooks.has(webhookId)) return { tipo: "duplicado" };
      webhooks.add(webhookId);
      return aplicarEventoFactura(repo, evento);
    },
  };
}
