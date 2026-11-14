/**
 * Conciliación: dado un pago CoDi recibido, encontrar a qué lead/cobro pertenece
 * y mover al lead a «Inscrito · Pagado». Lógica pura (sin red, sin storage) para
 * poder probarla en Node y reutilizarla en el Durable Object del tablero.
 */
import type { PagoRecibido, Proveedor } from "./pagos/tipos.ts";

export type Etapa = "nuevo" | "informes" | "cobro_enviado" | "pagado" | "revision";

export const ETAPAS: { id: Etapa; nombre: string }[] = [
  { id: "nuevo", nombre: "Nuevo" },
  { id: "informes", nombre: "Informes enviados" },
  { id: "cobro_enviado", nombre: "Cobro CoDi enviado" },
  { id: "pagado", nombre: "Inscrito · Pagado" },
];

/** El Mensaje de Cobro vigente de un lead (push primero; QR si la familia lo pide). */
export interface CobroActivo {
  medio: "push" | "qr";
  proveedor: Proveedor;
  /** push: transactionId de Pey · qr: IDC de Banxico. */
  id: string;
  folioCodi?: string;
  qrString?: string;
  celular?: string; // enmascarado
  montoMXN: number;
  concepto: string;
  referencia: string;
  expiraEn: number;
  creadoEn: number;
}

export interface Lead {
  id: string;
  familia: string;
  grado: string;
  canal: "WhatsApp";
  etapa: Etapa;
  demo?: boolean; // el lead que maneja quien prueba la demo
  cobro?: CobroActivo;
  pago?: {
    medio: "push" | "qr";
    transaccionId: string;
    montoMXN: number;
    comisionMXN: 0;
    pagadoEn: number;
    claveRastreo?: string;
    conciliadoEn: number;
  };
  nota?: string;
}

export type Resultado =
  | { tipo: "conciliado"; leadId: string }
  | { tipo: "duplicado"; leadId: string }
  | { tipo: "monto_distinto"; leadId: string; esperado: number; recibido: number }
  | { tipo: "sin_cobro" };

const CENTAVO = 0.005;

/**
 * Busca el lead del pago: primero por metadatos.leadId (los mandamos al crear el
 * cobro), luego por IDC del QR y por último por referencia numérica + monto.
 * Devuelve la nueva lista de leads (no muta la original).
 */
export function conciliar(
  leads: Lead[],
  pago: PagoRecibido,
  ahora: number,
): { leads: Lead[]; resultado: Resultado } {
  const conCobro = leads.filter((l) => l.cobro);
  const lead =
    conCobro.find((l) => l.id === pago.metadatos.leadId) ??
    conCobro.find((l) => l.cobro!.id === pago.cobroId || l.cobro!.id === pago.transaccionId) ??
    conCobro.find(
      (l) => l.cobro!.referencia === pago.referencia && Math.abs(l.cobro!.montoMXN - pago.montoMXN) < CENTAVO,
    );

  if (!lead) return { leads, resultado: { tipo: "sin_cobro" } };
  if (lead.pago?.transaccionId === pago.transaccionId) {
    return { leads, resultado: { tipo: "duplicado", leadId: lead.id } };
  }

  const esperado = lead.cobro!.montoMXN;
  const montoOk = Math.abs(esperado - pago.montoMXN) < CENTAVO;
  const actualizado: Lead = {
    ...lead,
    etapa: montoOk ? "pagado" : "revision",
    pago: {
      medio: pago.medio,
      transaccionId: pago.transaccionId,
      montoMXN: pago.montoMXN,
      comisionMXN: 0,
      pagadoEn: pago.pagadoEn,
      claveRastreo: pago.claveRastreo,
      conciliadoEn: ahora,
    },
    nota: montoOk ? undefined : `Pagó ${pago.montoMXN} de ${esperado}: revisar`,
  };
  return {
    leads: leads.map((l) => (l.id === lead.id ? actualizado : l)),
    resultado: montoOk
      ? { tipo: "conciliado", leadId: lead.id }
      : { tipo: "monto_distinto", leadId: lead.id, esperado, recibido: pago.montoMXN },
  };
}

/** Referencia numérica CoDi de 7 dígitos que no choque con otra pendiente. */
export function nuevaReferencia(leads: Lead[], azar: () => number = Math.random): string {
  const usadas = new Set(leads.map((l) => l.cobro?.referencia));
  for (;;) {
    const r = String(1_000_000 + Math.floor(azar() * 9_000_000));
    if (!usadas.has(r)) return r;
  }
}
