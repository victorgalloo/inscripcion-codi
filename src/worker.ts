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
 *   POST /webhooks/codi            webhook real: verifica la firma (Standard Webhooks, HMAC-SHA256),
 *                                  concilia, mueve el lead a «Inscrito · Pagado» y avisa por ntfy
 */
import { Tablero, type EstadoTablero } from "./tablero.ts";
import { nuevaReferencia, type CobroActivo, type Lead } from "./conciliacion.ts";
import { PagosCoDiMock } from "./pagos/mock.ts";
import { PagosCoDiPey } from "./pagos/pey.ts";
import type { PagoRecibido, PagosCoDi, SolicitudCobro } from "./pagos/tipos.ts";
import { firmarWebhook, verificarWebhook } from "./webhooks.ts";
import { publicarNtfy, type ResultadoNtfy } from "./ntfy.ts";
import { qrSvg } from "./qr.ts";
import { CELULAR_DEMO, CUOTA_INSCRIPCION, ESCUELA_DEMO, VIGENCIA_SEGUNDOS } from "./demo.ts";

export { Tablero };

export interface Env {
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
  NTFY_TOKEN?: string;
}

const ESCUELA_RE = /^demo-[a-z0-9]{8,24}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function pagos(env: Env): PagosCoDi {
  if (env.PAGOS_PROVEEDOR === "pey") return new PagosCoDiPey({ apiKey: env.PEY_API_KEY ?? "" });
  return new PagosCoDiMock();
}

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

const pesos = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 });

// ───────────────────────── webhook ─────────────────────────

async function webhookCodi(req: Request, env: Env): Promise<Response> {
  if (!env.CODI_WEBHOOK_SECRET) return json({ error: "CODI_WEBHOOK_SECRET no configurado" }, 500);
  const cuerpo = await req.text();
  const v = await verificarWebhook(env.CODI_WEBHOOK_SECRET, req.headers, cuerpo);
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
  const { resultado, lead } = await t.aplicarPago(v.id, pago);

  const avisos: ResultadoNtfy[] = [];
  if (resultado.tipo === "conciliado" && lead && env.NTFY_TEMA) {
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
          titulo: `Familia · ${ESCUELA_DEMO.nombre} recibió tu pago`,
          mensaje: `Inscripción ${ESCUELA_DEMO.ciclo} · ${lead.grado} confirmada. ${pesos(pago.montoMXN)} · rastreo ${pago.claveRastreo ?? "—"}`,
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
  return json({ ok: true, webhookId: v.id, resultado, ntfy: avisos.map((a) => ({ status: a.status, id: a.id, error: a.error })) });
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

// ───────────────────────── API ─────────────────────────

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const ruta = url.pathname;

  if (ruta === "/api/config" && req.method === "GET") {
    const base = env.NTFY_BASE ?? "https://ntfy.sh";
    const ntfyUrl = env.NTFY_TEMA ? `${base}/${env.NTFY_TEMA}` : null;
    return json({
      proveedor: env.PAGOS_PROVEEDOR,
      escuela: ESCUELA_DEMO,
      ntfy: ntfyUrl
        ? { tema: env.NTFY_TEMA, servidor: base, url: ntfyUrl, qr: qrSvg(ntfyUrl) }
        : null,
      webhookConfigurado: Boolean(env.CODI_WEBHOOK_SECRET),
    });
  }

  if (ruta === "/api/tablero" && req.method === "GET") {
    const escuela = escuelaDe(url.searchParams.get("escuela"));
    return json(await tablero(env, escuela).estado());
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const body = await leerJson(req);
  const escuela = escuelaDe(body.escuela);
  const t = tablero(env, escuela);

  if (ruta === "/api/demo/iniciar") {
    const actual: EstadoTablero = await t.estado();
    return json(actual.leads.length && !body.reiniciar ? actual : await t.iniciar(escuela));
  }

  if (ruta === "/api/leads") {
    const lead: Lead = {
      id: "lead-" + crypto.randomUUID().slice(0, 8),
      familia: "Familia Demo (tú)",
      grado: CUOTA_INSCRIPCION.grado,
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
    const solicitud: SolicitudCobro = {
      montoMXN: CUOTA_INSCRIPCION.montoMXN,
      concepto: CUOTA_INSCRIPCION.concepto,
      // Si ya hubo un cobro (p. ej. push rechazado), el QR conserva la misma referencia.
      referencia: lead.cobro?.referencia ?? nuevaReferencia(leads),
      vigenciaSegundos: VIGENCIA_SEGUNDOS,
      metadatos: { escuelaId: escuela, leadId },
    };
    const ahora = Date.now();
    let cobro: CobroActivo;
    if (medio === "push") {
      const c = await p.crearCobroPush(celular, solicitud);
      cobro = { ...c, medio: "push", id: c.transaccionId, creadoEn: ahora };
    } else {
      const c = await p.crearCobroQR(solicitud);
      cobro = { ...c, medio: "qr", creadoEn: ahora };
    }
    await t.guardarCobro(leadId, cobro);
    return json({
      cobro,
      beneficiario: ESCUELA_DEMO.nombre,
      qrSvg: cobro.qrString ? qrSvg(cobro.qrString) : undefined,
    });
  }

  if (ruta === "/api/demo/aceptar") {
    if (env.PAGOS_PROVEEDOR !== "mock") throw new ErrorHttp(403, "solo en modo mock");
    if (!env.CODI_WEBHOOK_SECRET) throw new ErrorHttp(500, "CODI_WEBHOOK_SECRET no configurado");
    const { lead } = await t.lead(String(body.leadId ?? ""));
    if (!lead?.cobro) throw new ErrorHttp(404, "no hay cobro vigente");
    const evento = new PagosCoDiMock().simularAceptacion(lead.cobro, { escuelaId: escuela, leadId: lead.id });
    return json({ webhook: await entregarWebhook(env, url.origin, evento) });
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
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      const status = e instanceof ErrorHttp ? e.status : 500;
      return json({ error: (e as Error).message }, status);
    }
  },
} satisfies ExportedHandler<Env>;
