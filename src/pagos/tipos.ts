/**
 * PagosCoDi — la única puerta entre el CRM de admisiones y CoDi®.
 *
 * El resto del sistema (agente de WhatsApp, tablero de admisiones, conciliación)
 * solo conoce esta interfaz. Hoy hay dos implementaciones:
 *
 *   - `PagosCoDiMock` (src/pagos/mock.ts): CoDi SIMULADO. Es lo que usa la demo pública.
 *     No mueve dinero; genera cobros y eventos con la misma forma que los de Pey.
 *   - `PagosCoDiPey`  (src/pagos/pey.ts): cliente de la API pública de Pey
 *     (https://docs.pey.mx, OpenAPI versión 2026-10-20). Se activa con
 *     PAGOS_PROVEEDOR="pey" y los secretos PEY_API_KEY / PEY_WEBHOOK_SECRET.
 *
 * Vocabulario CoDi (Reglas del SPEI, Banxico, Circular 8/2019 · Apéndice AD del Manual):
 *   - Cliente Beneficiario: quien cobra (el colegio).
 *   - Cliente Emisor: quien paga (la familia).
 *   - Mensaje de Cobro: lo que genera el beneficiario con 1) Monto, 2) Concepto de pago,
 *     3) Referencia Numérica y 4) Tiempo de vigencia. Se entrega por QR, NFC o por
 *     internet como notificación push a la app bancaria ligada al celular del emisor.
 *   - El emisor puede Aceptar, Rechazar o Posponer. Si acepta, su banco envía una
 *     Orden de Transferencia CoDi (SPEI, 24x7, sin comisión). Al cumplirse la
 *     vigencia sin respuesta, el mensaje pasa a "vencido".
 *
 * Flujo principal de este proyecto: COBRO PUSH al celular que la familia ya usa en
 * WhatsApp. Respaldo: COBRO QR en el mismo chat.
 */

export type Proveedor = "mock" | "pey";

/** Datos de un Mensaje de Cobro CoDi. */
export interface SolicitudCobro {
  /** Monto, en pesos mexicanos (MXN). > 0 y <= 1,000,000. */
  montoMXN: number;
  /** Concepto de pago que verá la familia en su app bancaria. */
  concepto: string;
  /** Referencia Numérica: 1 a 7 dígitos. Es la llave de conciliación. */
  referencia: string;
  /** Tiempo de vigencia, en segundos (mínimo 360 en Pey). */
  vigenciaSegundos: number;
  /** Datos propios (escuela, lead). Pey los devuelve en el webhook. Solo valores escalares. */
  metadatos: Record<string, string>;
}

/** Cobro por código QR, listo para mostrarse en el chat. */
export interface CobroQR {
  proveedor: Proveedor;
  /** Identificador del QR asignado por Banxico (IDC). */
  id: string;
  /** Contenido del QR que lee la app bancaria. */
  qrString: string;
  montoMXN: number;
  concepto: string;
  referencia: string;
  /** Unix (segundos) en que vence el cobro. */
  expiraEn: number;
}

/** Mensaje de Cobro enviado como notificación push a la app bancaria de la familia. */
export interface CobroPush {
  proveedor: Proveedor;
  /** Celular enmascarado (solo últimos 2 dígitos) para mostrar en el CRM. */
  celular: string;
  /** Id de la transacción en el proveedor (para consultar su estado). */
  transaccionId: string;
  /** Folio CoDi asignado por Banxico (20 dígitos). */
  folioCodi: string;
  montoMXN: number;
  concepto: string;
  referencia: string;
  expiraEn: number;
}

/** Evento normalizado: "llegó un pago CoDi". Es lo que consume la conciliación. */
export interface PagoRecibido {
  medio: "qr" | "push";
  transaccionId: string;
  /** IDC del QR pagado (solo en pagos por QR). */
  cobroId?: string;
  montoMXN: number;
  referencia: string;
  concepto: string;
  /** Unix (segundos) en que se completó el pago. */
  pagadoEn: number;
  /** Clave de rastreo SPEI, si el proveedor la entrega. */
  claveRastreo?: string;
  /** Los metadatos que mandamos al crear el cobro. */
  metadatos: Record<string, string>;
}

export interface EstadoTransaccion {
  id: string;
  estado: "PENDIENTE" | "PAGADO";
  montoMXN: number;
  pagadoEn?: number;
}

export interface PagosCoDi {
  readonly proveedor: Proveedor;
  /**
   * FLUJO PRINCIPAL. Envía el Mensaje de Cobro como notificación push a la app
   * bancaria registrada en CoDi para ese celular (10 dígitos).
   */
  crearCobroPush(celular: string, solicitud: SolicitudCobro): Promise<CobroPush>;
  /** RESPALDO. Genera el Mensaje de Cobro como código QR para mostrarlo en el chat. */
  crearCobroQR(solicitud: SolicitudCobro): Promise<CobroQR>;
  /** Consulta el estado de una transacción (respaldo si no llega el webhook). */
  consultarTransaccion(id: string): Promise<EstadoTransaccion>;
  /** Convierte el cuerpo de un webhook (ya verificado) en un PagoRecibido. */
  interpretarWebhook(payload: unknown): PagoRecibido;
}

/** Validaciones comunes a cualquier proveedor (reglas de CoDi vía Pey). */
export function validarSolicitud(s: SolicitudCobro): void {
  if (!(Number.isFinite(s.montoMXN) && s.montoMXN > 0 && s.montoMXN <= 1_000_000)) {
    throw new Error("El monto debe ser mayor a 0 y hasta 1,000,000 MXN");
  }
  if (Math.abs(Math.round(s.montoMXN * 100) - s.montoMXN * 100) > 1e-6) {
    throw new Error("El monto admite máximo dos decimales");
  }
  if (!/^[0-9]{1,7}$/.test(s.referencia)) {
    throw new Error("La referencia numérica debe tener de 1 a 7 dígitos");
  }
  if (!Number.isInteger(s.vigenciaSegundos) || s.vigenciaSegundos < 360) {
    throw new Error("La vigencia mínima es de 360 segundos");
  }
  if (!s.concepto.trim()) throw new Error("El concepto es obligatorio");
  if (Object.keys(s.metadatos).length > 50) throw new Error("Máximo 50 metadatos");
}

export function validarCelular(celular: string): void {
  if (!/^[0-9]{10}$/.test(celular)) throw new Error("El celular debe tener 10 dígitos");
}

export function enmascararCelular(celular: string): string {
  return "•• •••• ••" + celular.slice(-2);
}
