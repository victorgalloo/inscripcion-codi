/**
 * PagosCoDiMock — CoDi SIMULADO para la demo.
 *
 * ⚠️  No mueve dinero ni habla con Banxico ni con Pey.
 * Genera cobros y webhooks con la MISMA forma que la API de Pey, de modo que
 * el resto del sistema (verificación de firma, conciliación, tablero) corre el
 * mismo código que correría en producción. Cambiar a Pey real = cambiar de clase.
 */
import type {
  CobroPush,
  CobroQR,
  EstadoCobro,
  EstadoTransaccion,
  PagoRecibido,
  PagosCoDi,
  SolicitudCobro,
} from "./tipos.ts";
import { enmascararCelular, validarCelular, validarSolicitud } from "./tipos.ts";
import { interpretarEventoPey, type EventoPey } from "./pey.ts";

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Id con forma de ULID (26 caracteres Crockford base32). Solo para la demo. */
export function idTipoUlid(azar: () => number = Math.random, ahoraMs = Date.now()): string {
  let t = ahoraMs;
  let tiempo = "";
  for (let i = 0; i < 10; i++) {
    tiempo = BASE32[t % 32] + tiempo;
    t = Math.floor(t / 32);
  }
  let resto = "";
  for (let i = 0; i < 16; i++) resto += BASE32[Math.floor(azar() * 32)];
  return tiempo + resto;
}

function digitos(n: number, azar: () => number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(azar() * 10);
  return s;
}

export class PagosCoDiMock implements PagosCoDi {
  readonly proveedor = "mock" as const;
  private azar: () => number;
  private ahora: () => number;
  /** Cobros emitidos en esta instancia (solo para consultarTransaccion). */
  private emitidos = new Map<string, { montoMXN: number; pagadoEn?: number }>();

  constructor(opciones: { azar?: () => number; ahora?: () => number } = {}) {
    this.azar = opciones.azar ?? Math.random;
    this.ahora = opciones.ahora ?? (() => Math.floor(Date.now() / 1000));
  }

  async crearCobroQR(s: SolicitudCobro): Promise<CobroQR> {
    validarSolicitud(s);
    // IDC simulado: 10 hex como en los ejemplos de Pey, con prefijo DEMO para que nadie lo confunda.
    const idc = "DEMO" + Array.from({ length: 6 }, () => "0123456789abcdef"[Math.floor(this.azar() * 16)]).join("");
    // Misma estructura que el qrString de ejemplo de Pey, marcado como demo.
    const qrString = JSON.stringify({ TYP: 1, v: "01", ic: 0, IDC: idc, DEMO: "CoDi simulado - no pagar" });
    this.emitidos.set(idc, { montoMXN: s.montoMXN });
    return {
      proveedor: "mock",
      id: idc,
      qrString,
      montoMXN: s.montoMXN,
      concepto: s.concepto,
      referencia: s.referencia,
      expiraEn: this.ahora() + s.vigenciaSegundos,
    };
  }

  async crearCobroPush(celular: string, s: SolicitudCobro): Promise<CobroPush> {
    validarSolicitud(s);
    validarCelular(celular);
    const transaccionId = idTipoUlid(this.azar, this.ahora() * 1000);
    this.emitidos.set(transaccionId, { montoMXN: s.montoMXN });
    return {
      proveedor: "mock",
      celular: enmascararCelular(celular),
      transaccionId,
      folioCodi: digitos(20, this.azar),
      montoMXN: s.montoMXN,
      concepto: s.concepto,
      referencia: s.referencia,
      expiraEn: this.ahora() + s.vigenciaSegundos,
    };
  }

  async consultarTransaccion(id: string): Promise<EstadoTransaccion> {
    const t = this.emitidos.get(id);
    if (!t) throw new Error("Transacción no encontrada (mock)");
    return { id, estado: t.pagadoEn ? "PAGADO" : "PENDIENTE", montoMXN: t.montoMXN, pagadoEn: t.pagadoEn };
  }

  /**
   * Simula la consulta que haría Pey al vencer el cobro. Sin aceptación simulada
   * en esta instancia responde PENDIENTE (lo mismo que Pey cuando la familia
   * rechazó, pospuso o no vio el cobro: Pey no distingue esos casos).
   */
  async estadoCobro(cobro: { medio: "push" | "qr"; id: string }): Promise<EstadoCobro> {
    const t = this.emitidos.get(cobro.id);
    if (!t?.pagadoEn) return { estado: "PENDIENTE" };
    return { estado: "PAGADO", transaccionId: cobro.id, montoMXN: t.montoMXN, pagadoEn: t.pagadoEn };
  }

  interpretarWebhook(payload: unknown): PagoRecibido {
    return interpretarEventoPey(payload);
  }

  /**
   * Simula que la familia ACEPTÓ el Mensaje de Cobro en la app de su banco:
   * produce el webhook que mandaría Pey (`codi.pn.payment_received` para push,
   * `codi.qr.payment_received` para QR). Los datos bancarios son ceros/ficticios.
   * (Rechazar o posponer no genera webhook, igual que en Pey.)
   */
  simularAceptacion(
    cobro: { medio: "push" | "qr"; id: string; montoMXN: number; concepto: string; referencia: string },
    metadatos: Record<string, string>,
    montoPagado = cobro.montoMXN,
  ): EventoPey {
    const pagadoEn = this.ahora();
    const previo = this.emitidos.get(cobro.id);
    if (previo) previo.pagadoEn = pagadoEn;
    return {
      type: cobro.medio === "push" ? "codi.pn.payment_received" : "codi.qr.payment_received",
      amount: montoPagado,
      apiKeyId: "DEMO0000000000000000000000",
      ...(cobro.medio === "qr" ? { codiQrId: cobro.id } : {}),
      concept: cobro.concepto,
      datePaid: pagadoEn,
      numRef: cobro.referencia,
      // En push, Pey reporta la misma transacción que devolvió al crear el cobro.
      transactionId: cobro.medio === "push" ? cobro.id : idTipoUlid(this.azar, pagadoEn * 1000),
      metadata: {
        clabe: "000000000000000000",
        bankCode: 0,
        accountType: 40,
        description: cobro.concepto,
        trackingKey: "DEMO" + digitos(10, this.azar),
        externalMetadata: metadatos,
      },
    };
  }
}
