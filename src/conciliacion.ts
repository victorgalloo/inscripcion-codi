/**
 * Conciliación: dado un pago CoDi recibido, encontrar a qué lead/cobro pertenece
 * y mover al lead a «Inscrito · Pagado». Lógica pura (sin red, sin storage) para
 * poder probarla en Node y reutilizarla en el Durable Object del tablero.
 */
import type { PagoRecibido, Proveedor } from "./pagos/tipos.ts";
import type { RegistroFactura } from "./facturacion/tipos.ts";

export type Etapa = "nuevo" | "informes" | "cobro_enviado" | "pagado" | "revision";

export const ETAPAS: { id: Etapa; nombre: string }[] = [
  { id: "nuevo", nombre: "Nuevo" },
  { id: "informes", nombre: "Informes enviados" },
  { id: "cobro_enviado", nombre: "Cobro CoDi enviado" },
  { id: "pagado", nombre: "Inscrito · Pagado" },
];

/**
 * Estado de un Mensaje de Cobro desde el lado del colegio.
 *   vigente               enviado y dentro de su vigencia
 *   vencido_o_rechazado   llegó la vigencia sin pago (Pey no distingue rechazo de vencimiento)
 *   sustituido            se mandó otro cobro nuevo en su lugar (p. ej. el QR de respaldo)
 * Un cobro que no está vigente NUNCA se reutiliza: se genera uno nuevo, con folio y referencia nuevos.
 */
export type EstadoCobroActivo = "vigente" | "vencido_o_rechazado" | "sustituido";

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
  /** Ausente en datos viejos = vigente. */
  estado?: EstadoCobroActivo;
}

export interface Lead {
  id: string;
  familia: string;
  grado: string;
  canal: "WhatsApp";
  etapa: Etapa;
  demo?: boolean; // el lead que maneja quien prueba la demo
  cobro?: CobroActivo;
  /** Cobros anteriores (vencidos o sustituidos), solo para auditoría. */
  cobrosAnteriores?: CobroActivo[];
  pago?: {
    medio: "push" | "qr";
    transaccionId: string;
    montoMXN: number;
    comisionMXN: 0;
    pagadoEn: number;
    claveRastreo?: string;
    /** Folio CoDi del cobro pagado (push) o IDC del QR. */
    folioCodi?: string;
    /** CLABE de origen enmascarada (nunca completa). */
    clabeOrdenante?: string;
    conciliadoEn: number;
  };
  /** CFDI que emitió el agente facturador al conciliarse el pago (src/facturador.ts). */
  factura?: RegistroFactura;
  nota?: string;
}

/**
 * Cobro a un contacto (modo «Cobrar a un contacto»): un negocio le cobra por CoDi a
 * cualquier contacto desde un formulario de WhatsApp. Reutiliza la forma de Lead para
 * pasar por la MISMA conciliación y el MISMO vencimiento: `familia` = nombre del contacto,
 * `grado` = concepto.
 */
export interface CobroContacto extends Lead {
  tipo: "contacto";
  /** flow_token del WhatsApp Flow que lo creó (uno por cobro). */
  flowToken: string;
}

export type Resultado =
  | { tipo: "conciliado"; leadId: string }
  | { tipo: "duplicado"; leadId: string }
  | {
      tipo: "no_coincide";
      leadId: string;
      motivo: string;
      esperado: { montoMXN: number; referencia: string };
      recibido: { montoMXN: number; referencia: string };
    }
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
  const ids = (l: Lead) => [l.cobro!, ...(l.cobrosAnteriores ?? [])].map((c) => c.id);
  const lead =
    conCobro.find((l) => l.id === pago.metadatos.leadId) ??
    conCobro.find((l) => l.id === pago.metadatos.cobroContactoId) ??
    conCobro.find((l) => ids(l).includes(pago.cobroId ?? "") || ids(l).includes(pago.transaccionId)) ??
    conCobro.find(
      (l) => l.cobro!.referencia === pago.referencia && Math.abs(l.cobro!.montoMXN - pago.montoMXN) < CENTAVO,
    );

  if (!lead) return { leads, resultado: { tipo: "sin_cobro" } };
  if (lead.pago?.transaccionId === pago.transaccionId) {
    return { leads, resultado: { tipo: "duplicado", leadId: lead.id } };
  }

  // El pago debe ser idéntico al cobro que mandamos: mismo monto y misma referencia.
  // Si no, NO se marca pagado ni se avisa al colegio como inscrito: va a revisión humana.
  const cobro = lead.cobro!;
  const esperado = { montoMXN: cobro.montoMXN, referencia: cobro.referencia };
  const recibido = { montoMXN: pago.montoMXN, referencia: pago.referencia };
  const motivos: string[] = [];
  if (lead.etapa === "pagado") motivos.push("el lead ya estaba pagado");
  if (Math.abs(esperado.montoMXN - recibido.montoMXN) >= CENTAVO) motivos.push("monto distinto");
  if (esperado.referencia !== recibido.referencia) motivos.push("referencia distinta");

  if (motivos.length) {
    const motivo = motivos.join(" y ");
    const actualizado: Lead = {
      ...lead,
      etapa: lead.etapa === "pagado" ? "pagado" : "revision",
      nota: `Pago CoDi rechazado en conciliación (${motivo}): ${recibido.montoMXN} ref ${recibido.referencia} · esperado ${esperado.montoMXN} ref ${esperado.referencia}. Revisar o devolver desde el banco del colegio.`,
    };
    return {
      leads: leads.map((l) => (l.id === lead.id ? actualizado : l)),
      resultado: { tipo: "no_coincide", leadId: lead.id, motivo, esperado, recibido },
    };
  }

  const actualizado: Lead = {
    ...lead,
    etapa: "pagado",
    pago: {
      medio: pago.medio,
      transaccionId: pago.transaccionId,
      montoMXN: pago.montoMXN,
      comisionMXN: 0,
      pagadoEn: pago.pagadoEn,
      claveRastreo: pago.claveRastreo,
      folioCodi: cobro.folioCodi ?? cobro.id,
      clabeOrdenante: pago.clabeOrdenante,
      conciliadoEn: ahora,
    },
    nota: undefined,
  };
  return {
    leads: leads.map((l) => (l.id === lead.id ? actualizado : l)),
    resultado: { tipo: "conciliado", leadId: lead.id },
  };
}

/** Referencia numérica CoDi de 7 dígitos que no choque con otra pendiente. */
export function nuevaReferencia(leads: Lead[], azar: () => number = Math.random, otras: Iterable<string> = []): string {
  // Incluye las de cobros vencidos o sustituidos: una referencia nunca se reutiliza.
  const usadas = new Set<string | undefined>([
    ...leads.flatMap((l) => [l.cobro, ...(l.cobrosAnteriores ?? [])].map((c) => c?.referencia)),
    ...otras,
  ]);
  for (;;) {
    const r = String(1_000_000 + Math.floor(azar() * 9_000_000));
    if (!usadas.has(r)) return r;
  }
}
