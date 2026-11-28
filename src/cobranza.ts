/**
 * Agente de cobranza vía CoDi (idea central, Victor 26-nov-2026).
 *
 * El día de la colegiatura el agente manda SOLO el cobro: push CoDi al celular de
 * la familia + mensaje de WhatsApp. Antes y después, recordatorios. Nadie persigue
 * a nadie: si la familia paga, la secuencia se detiene; si no, el agente reintenta
 * con un cobro NUEVO (nunca reutiliza uno vencido), ofrece QR y liga, y al final
 * avisa al colegio para que una persona hable con la familia.
 *
 * Lógica pura (sin storage ni red): el Durable Object la llama desde su alarma con
 * `pasosPendientes(plan, mes, ahora)` y ejecuta lo que devuelve.
 *
 * Hora: centro de México (UTC-6 todo el año desde 2022, sin horario de verano).
 */
import { pesos } from "./mensajes.ts";

export const OFFSET_CDMX_SEG = -6 * 3600;

export interface PlanColegiatura {
  familiaId: string;
  alumno: string; // nombre de pila, ficticio en la demo
  celular: string; // de la conversación; nunca se imprime completo
  montoMXN: number;
  /** Día del mes en que se cobra (1-28 para que exista en todos los meses). */
  diaDePago: number;
  /** Descuento por pagar el mismo día con CoDi (opcional, en pesos). */
  descuentoProntoPagoMXN?: number;
  /** ¿La familia ya tiene CoDi activo? Si no, el agente de adopción entra antes. */
  codiActivo: boolean;
}

export type TipoPaso =
  | "adopcion" // D-5: aún no tiene CoDi → guía de activación (src/activacion.ts)
  | "aviso_previo" // D-3: «el jueves te llega la solicitud CoDi»
  | "aviso_vispera" // D-1: «mañana a las 9»
  | "cobro_dia" // D 9:00: push CoDi + WhatsApp
  | "reintento_tarde" // D 18:00: push nuevo si no pagó
  | "reintento_siguiente" // D+1 9:00: push nuevo + QR de respaldo
  | "ultimo_aviso" // D+3 9:00: push + QR + liga de pago
  | "escalar_colegio"; // D+5 9:00: el colegio llama; el agente deja de insistir

export interface Paso {
  tipo: TipoPaso;
  en: number; // unix seg
  /** true = este paso genera un Mensaje de Cobro CoDi nuevo por el API. */
  cobra: boolean;
  medios: ReadonlyArray<"push" | "qr" | "liga" | "whatsapp" | "aviso_colegio">;
}

interface Regla {
  tipo: TipoPaso;
  dia: number; // relativo al día de pago
  hora: number; // hora CDMX
  cobra: boolean;
  medios: Paso["medios"];
  soloSinCodi?: boolean;
}

export const SECUENCIA: readonly Regla[] = [
  { tipo: "adopcion", dia: -5, hora: 10, cobra: false, medios: ["whatsapp"], soloSinCodi: true },
  { tipo: "aviso_previo", dia: -3, hora: 10, cobra: false, medios: ["whatsapp"] },
  { tipo: "aviso_vispera", dia: -1, hora: 18, cobra: false, medios: ["whatsapp"] },
  { tipo: "cobro_dia", dia: 0, hora: 9, cobra: true, medios: ["push", "whatsapp"] },
  { tipo: "reintento_tarde", dia: 0, hora: 18, cobra: true, medios: ["push", "whatsapp"] },
  { tipo: "reintento_siguiente", dia: 1, hora: 9, cobra: true, medios: ["push", "qr", "whatsapp"] },
  { tipo: "ultimo_aviso", dia: 3, hora: 9, cobra: true, medios: ["push", "qr", "liga", "whatsapp"] },
  { tipo: "escalar_colegio", dia: 5, hora: 9, cobra: false, medios: ["aviso_colegio"] },
];

/** Unix (s) de `hora`:00 CDMX del día `dia` de `mes` (1-12) de `anio`. */
export function instanteCdmx(anio: number, mes: number, dia: number, hora: number): number {
  return Date.UTC(anio, mes - 1, dia, hora) / 1000 - OFFSET_CDMX_SEG;
}

export function validarPlan(p: PlanColegiatura): void {
  if (!Number.isInteger(p.diaDePago) || p.diaDePago < 1 || p.diaDePago > 28) {
    throw new Error("diaDePago debe ser un entero de 1 a 28");
  }
  if (!(p.montoMXN > 0)) throw new Error("montoMXN debe ser mayor que 0");
  const desc = p.descuentoProntoPagoMXN ?? 0;
  if (desc < 0 || desc >= p.montoMXN) throw new Error("descuento fuera de rango");
}

/** Calendario completo de un mes de colegiatura (anio, mes 1-12). */
export function calendarioDelMes(p: PlanColegiatura, anio: number, mes: number): Paso[] {
  validarPlan(p);
  return SECUENCIA.filter((r) => !r.soloSinCodi || !p.codiActivo).map((r) => ({
    tipo: r.tipo,
    // Date.UTC normaliza días negativos o mayores al mes (cruza de mes bien).
    en: instanteCdmx(anio, mes, p.diaDePago + r.dia, r.hora),
    cobra: r.cobra,
    medios: r.medios,
  }));
}

export interface EstadoMes {
  pagado: boolean;
  /** Tipos de paso ya ejecutados este mes. */
  hechos: readonly TipoPaso[];
}

/**
 * Lo que toca hacer ahora. Si ya pagó, nada. Si se juntaron varios pasos (la
 * alarma se atrasó), solo se ejecuta el MÁS reciente: nunca dos pushes seguidos.
 */
export function pasosPendientes(p: PlanColegiatura, anio: number, mes: number, estado: EstadoMes, ahora: number): Paso[] {
  if (estado.pagado) return [];
  const vencidos = calendarioDelMes(p, anio, mes).filter((x) => x.en <= ahora && !estado.hechos.includes(x.tipo));
  return vencidos.length ? [vencidos[vencidos.length - 1]!] : [];
}

/** Siguiente instante para programar la alarma, o undefined si el mes terminó o ya pagó. */
export function proximaAlarma(p: PlanColegiatura, anio: number, mes: number, estado: EstadoMes, ahora: number): number | undefined {
  if (estado.pagado) return undefined;
  return calendarioDelMes(p, anio, mes).find((x) => x.en > ahora && !estado.hechos.includes(x.tipo))?.en;
}

/** Monto a cobrar en ese paso: el descuento por pronto pago solo vale el día de pago. */
export function montoDelPaso(p: PlanColegiatura, tipo: TipoPaso): number {
  const desc = p.descuentoProntoPagoMXN ?? 0;
  return tipo === "cobro_dia" || tipo === "reintento_tarde" ? p.montoMXN - desc : p.montoMXN;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Texto de WhatsApp de cada paso (el detalle del cobro lo agrega mensajeAntesDelCobro). */
export function mensajePaso(p: PlanColegiatura, tipo: TipoPaso, mes: number): string {
  const m = MESES[mes - 1] ?? "";
  const monto = pesos(montoDelPaso(p, tipo));
  const desc = p.descuentoProntoPagoMXN
    ? ` Si pagas ese día con CoDi te queda en ${pesos(p.montoMXN - p.descuentoProntoPagoMXN)}.`
    : "";
  switch (tipo) {
    case "adopcion":
      return `Hola 👋 La colegiatura de ${m} de ${p.alumno} ya se puede pagar con CoDi: un toque en la app de tu banco, sin comisión y sin dictar CLABE. ¿Con qué banco pagas? Te digo cómo activarlo en un minuto.`;
    case "aviso_previo":
      return `Hola 👋 El día ${p.diaDePago} te llega a la app de tu banco la solicitud CoDi de la colegiatura de ${m} de ${p.alumno} (${pesos(p.montoMXN)}).${desc} Solo tocas Aceptar.`;
    case "aviso_vispera":
      // Mismo monto que traerá el push de mañana (con el descuento de pronto pago, si hay).
      return `Mañana a las 9:00 te llega la solicitud CoDi de la colegiatura de ${p.alumno}. Es de ${pesos(montoDelPaso(p, "cobro_dia"))}, sin comisión.`;
    case "cobro_dia":
      return `Ya te llegó la solicitud CoDi de la colegiatura de ${m} de ${p.alumno} por ${monto}. Ábrela en tu banco y toca Aceptar.`;
    case "reintento_tarde":
      return `Te reenvié la solicitud CoDi de la colegiatura de ${p.alumno} (${monto}); la de la mañana ya venció. Hoy todavía aplica el precio de pronto pago.`;
    case "reintento_siguiente":
      return `La colegiatura de ${p.alumno} sigue pendiente. Te mandé una solicitud CoDi nueva y este QR por si prefieres escanearlo desde otra app.`;
    case "ultimo_aviso":
      return `Último recordatorio de la colegiatura de ${m} de ${p.alumno} (${monto}): solicitud CoDi, QR o liga de pago, la que te quede mejor. Si necesitas otra fecha, dímelo aquí y lo veo con el colegio.`;
    case "escalar_colegio":
      return `Colegiatura de ${m} de ${p.alumno} sin pagar tras 5 cobros CoDi y recordatorios. El agente deja de insistir: toca que el colegio hable con la familia.`;
  }
}
