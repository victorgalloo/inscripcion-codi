/**
 * PagosCoDiPey — cliente de la API pública de Pey (https://docs.pey.mx).
 *
 * Escrito contra la especificación OpenAPI publicada por Pey (versión 2026-10-20):
 *   POST /codi/pn            → Mensaje de Cobro push al celular (200: { transactionId, codiId })
 *   POST /codi/qr            → Mensaje de Cobro en QR           (201: { id, qrString, qrImage? })
 *   GET  /transaction/{id}   → estado PENDING | PAID
 *   Webhooks firmados con Standard Webhooks:
 *     codi.qr.payment_received · codi.pn.payment_received
 *
 * ESTADO: implementado y probado con un `fetch` falso (test/pey.test.ts).
 * Aún NO se ha ejecutado contra api.pey.mx con una API key real; Pey recomienda
 * probar en producción con montos de $0.01 MXN mientras sale su ambiente de pruebas.
 */
import type {
  CobroPush,
  CobroQR,
  EstadoTransaccion,
  PagoRecibido,
  PagosCoDi,
  SolicitudCobro,
} from "./tipos.ts";
import { enmascararCelular, validarCelular, validarSolicitud } from "./tipos.ts";

export const PEY_API_BASE = "https://api.pey.mx";

export class ErrorPey extends Error {
  status: number;
  tipo: string;
  requestId?: string;
  constructor(status: number, tipo: string, mensaje: string, requestId?: string) {
    super(`Pey ${status} ${tipo}: ${mensaje}`);
    this.status = status;
    this.tipo = tipo;
    this.requestId = requestId;
  }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class PagosCoDiPey implements PagosCoDi {
  readonly proveedor = "pey" as const;
  private apiKey: string;
  private base: string;
  private fetcher: Fetcher;
  private ahora: () => number;

  constructor(opciones: {
    apiKey: string;
    base?: string;
    fetcher?: Fetcher;
    ahora?: () => number;
  }) {
    if (!opciones.apiKey) throw new Error("Falta PEY_API_KEY");
    this.apiKey = opciones.apiKey;
    this.base = opciones.base ?? PEY_API_BASE;
    this.fetcher = opciones.fetcher ?? ((i, init) => fetch(i, init));
    this.ahora = opciones.ahora ?? (() => Math.floor(Date.now() / 1000));
  }

  async crearCobroQR(s: SolicitudCobro): Promise<CobroQR> {
    validarSolicitud(s);
    const r = await this.llamar<{ id: string; qrString: string }>("POST", "/codi/qr", {
      amount: s.montoMXN,
      concept: s.concepto,
      expiration: s.vigenciaSegundos,
      numRef: s.referencia,
      generateImage: false, // el QR lo dibujamos nosotros a partir de qrString (más rápido)
      metadata: s.metadatos,
    });
    return {
      proveedor: "pey",
      id: r.id,
      qrString: r.qrString,
      montoMXN: s.montoMXN,
      concepto: s.concepto,
      referencia: s.referencia,
      expiraEn: this.ahora() + s.vigenciaSegundos,
    };
  }

  async crearCobroPush(celular: string, s: SolicitudCobro): Promise<CobroPush> {
    validarSolicitud(s);
    validarCelular(celular);
    const r = await this.llamar<{ transactionId: string; codiId: string }>("POST", "/codi/pn", {
      amount: s.montoMXN,
      phoneNumber: celular,
      concept: s.concepto,
      expiration: s.vigenciaSegundos,
      numRef: s.referencia,
      metadata: s.metadatos,
    });
    return {
      proveedor: "pey",
      celular: enmascararCelular(celular),
      transaccionId: r.transactionId,
      folioCodi: r.codiId,
      montoMXN: s.montoMXN,
      concepto: s.concepto,
      referencia: s.referencia,
      expiraEn: this.ahora() + s.vigenciaSegundos,
    };
  }

  async consultarTransaccion(id: string): Promise<EstadoTransaccion> {
    const r = await this.llamar<{ id: string; status: "PENDING" | "PAID"; amount: number; datePaid?: number }>(
      "GET",
      `/transaction/${encodeURIComponent(id)}`,
    );
    return {
      id: r.id,
      estado: r.status === "PAID" ? "PAGADO" : "PENDIENTE",
      montoMXN: r.amount,
      pagadoEn: r.datePaid,
    };
  }

  interpretarWebhook(payload: unknown): PagoRecibido {
    return interpretarEventoPey(payload);
  }

  private async llamar<T>(metodo: "GET" | "POST", ruta: string, cuerpo?: unknown): Promise<T> {
    const res = await this.fetcher(this.base + ruta, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(cuerpo ? { "Content-Type": "application/json" } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const texto = await res.text();
    let json: unknown = undefined;
    try {
      json = texto ? JSON.parse(texto) : undefined;
    } catch {
      /* respuesta no JSON */
    }
    if (!res.ok) {
      const e = (json as { error?: { type?: string; message?: string; requestId?: string } })?.error;
      throw new ErrorPey(res.status, e?.type ?? "ERROR", e?.message ?? texto.slice(0, 200), e?.requestId);
    }
    return json as T;
  }
}

/** Forma del webhook de Pey para pagos CoDi (QR y push). */
export interface EventoPey {
  type: "codi.qr.payment_received" | "codi.pn.payment_received";
  amount: number;
  apiKeyId: string;
  bankAccountId?: string;
  codiQrId?: string;
  concept: string;
  datePaid: number;
  numRef: string;
  transactionId: string;
  metadata?: {
    clabe?: string;
    bankCode?: number;
    accountType?: number;
    description?: string;
    trackingKey?: string;
    externalMetadata?: Record<string, unknown>;
  };
}

/** Normaliza un webhook de Pey (ya verificado) a PagoRecibido. Pura y sin red. */
export function interpretarEventoPey(payload: unknown): PagoRecibido {
  const e = payload as Partial<EventoPey> | null;
  if (!e || typeof e !== "object") throw new Error("Webhook vacío");
  if (e.type !== "codi.qr.payment_received" && e.type !== "codi.pn.payment_received") {
    throw new Error(`Evento no soportado: ${String(e.type)}`);
  }
  if (typeof e.amount !== "number" || typeof e.transactionId !== "string") {
    throw new Error("Webhook incompleto: falta amount o transactionId");
  }
  const externos = e.metadata?.externalMetadata ?? {};
  const metadatos: Record<string, string> = {};
  for (const [k, v] of Object.entries(externos)) metadatos[k] = String(v);
  return {
    medio: e.type === "codi.qr.payment_received" ? "qr" : "push",
    transaccionId: e.transactionId,
    cobroId: e.codiQrId,
    montoMXN: e.amount,
    referencia: String(e.numRef ?? "0"),
    concepto: e.concept ?? "",
    pagadoEn: e.datePaid ?? 0,
    claveRastreo: e.metadata?.trackingKey,
    metadatos,
  };
}
