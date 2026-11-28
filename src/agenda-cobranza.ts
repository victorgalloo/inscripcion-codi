/**
 * Agenda del agente de cobranza: lleva una colegiatura del mes de una familia de
 * principio a fin sobre el calendario de src/cobranza.ts.
 *
 * - `ejecutar(c, ahora, ejecutor)` corre lo que toque «ahora» (el Durable Object lo
 *   llama desde su alarma; la demo, al adelantar el reloj). Si el paso cobra, el
 *   ejecutor manda un Mensaje de Cobro CoDi NUEVO por el API (nunca reutiliza uno).
 * - `marcarPagada` concilia el webhook: solo vale si la referencia es de un cobro
 *   de ESTA colegiatura y el monto coincide; entonces la secuencia se detiene.
 * - `resumen` da los números del tablero: familias con CoDi (meta del agente de
 *   adopción), pagadas, cobros CoDi enviados y las que el colegio debe atender.
 *
 * Lógica pura: sin storage ni red. El celular nunca sale de aquí completo (`publica`).
 */
import {
  calendarioDelMes,
  mensajePaso,
  montoDelPaso,
  pasosPendientes,
  proximaAlarma,
  validarPlan,
  type Paso,
  type PlanColegiatura,
  type TipoPaso,
} from "./cobranza.ts";

export interface CobroColegiatura {
  tipo: TipoPaso;
  referencia: string;
  montoMXN: number;
  en: number; // unix s
  /** Id del proveedor (push: transactionId) y concepto, para consultar o simular el pago. */
  id?: string;
  concepto?: string;
}

export interface MensajeColegiatura {
  tipo: TipoPaso;
  en: number; // unix s
  texto: string;
  medios: Paso["medios"];
}

export interface Colegiatura {
  id: string;
  plan: PlanColegiatura;
  anio: number;
  mes: number; // 1-12
  pagada: boolean;
  pagadaEn?: number;
  /** Paso cuyo cobro se pagó (p. ej. «cobro_dia» = pagó a la primera). */
  pagadaCon?: TipoPaso;
  hechos: TipoPaso[];
  /** Reloj de la agenda (unix s): en producción es «ahora»; en la demo avanza a mano. */
  reloj: number;
  cobros: CobroColegiatura[];
  mensajes: MensajeColegiatura[];
  /** Demo: el reloj lo mueve quien prueba; la alarma real no la toca. */
  demo?: boolean;
}

export interface EjecutorCobranza {
  /** Manda un Mensaje de Cobro CoDi nuevo y devuelve su referencia. */
  cobrar(c: Colegiatura, paso: Paso, montoMXN: number): Promise<{ referencia: string; id?: string; concepto?: string }>;
}

/** Una colegiatura nueva; el reloj arranca un día antes del primer paso del mes. */
export function nuevaColegiatura(plan: PlanColegiatura, anio: number, mes: number): Colegiatura {
  validarPlan(plan);
  const primero = calendarioDelMes(plan, anio, mes)[0]!;
  return {
    id: `${plan.familiaId}-${anio}-${String(mes).padStart(2, "0")}`,
    plan,
    anio,
    mes,
    pagada: false,
    hechos: [],
    reloj: primero.en - 24 * 3600,
    cobros: [],
    mensajes: [],
  };
}

/** El siguiente paso que falta, según el reloj de la colegiatura. */
export function siguientePaso(c: Colegiatura): Paso | undefined {
  const en = proximaAlarma(c.plan, c.anio, c.mes, { pagado: c.pagada, hechos: c.hechos }, c.reloj);
  return en === undefined ? undefined : calendarioDelMes(c.plan, c.anio, c.mes).find((p) => p.en === en);
}

/** Corre lo que toca en `ahora` (a lo más un paso; ver pasosPendientes). */
export async function ejecutar(
  c: Colegiatura,
  ahora: number,
  ejecutor: EjecutorCobranza,
): Promise<{ colegiatura: Colegiatura; paso?: Paso }> {
  const reloj = Math.max(c.reloj, ahora);
  const [paso] = pasosPendientes(c.plan, c.anio, c.mes, { pagado: c.pagada, hechos: c.hechos }, reloj);
  if (!paso) return { colegiatura: { ...c, reloj } };
  // Los pasos que se saltaron (alarma atrasada) cuentan como hechos: nunca se repiten.
  const saltados = calendarioDelMes(c.plan, c.anio, c.mes)
    .filter((p) => p.en <= paso.en && !c.hechos.includes(p.tipo))
    .map((p) => p.tipo);
  const cobros = [...c.cobros];
  if (paso.cobra) {
    const montoMXN = montoDelPaso(c.plan, paso.tipo);
    const r = await ejecutor.cobrar(c, paso, montoMXN);
    cobros.push({ tipo: paso.tipo, montoMXN, en: reloj, ...r });
  }
  const mensaje: MensajeColegiatura = { tipo: paso.tipo, en: reloj, texto: mensajePaso(c.plan, paso.tipo, c.mes), medios: paso.medios };
  return {
    colegiatura: { ...c, reloj, hechos: [...c.hechos, ...saltados], cobros, mensajes: [...c.mensajes, mensaje] },
    paso,
  };
}

/** Demo: adelanta el reloj al siguiente paso y lo ejecuta. */
export async function avanzar(c: Colegiatura, ejecutor: EjecutorCobranza): Promise<{ colegiatura: Colegiatura; paso?: Paso }> {
  const p = siguientePaso(c);
  return p ? ejecutar(c, p.en, ejecutor) : { colegiatura: c };
}

export type ResultadoPagoColegiatura =
  | { tipo: "conciliado"; colegiatura: Colegiatura }
  | { tipo: "duplicado"; colegiatura: Colegiatura }
  | { tipo: "no_coincide"; motivo: string };

/** Concilia un pago CoDi contra los cobros de esta colegiatura. */
export function marcarPagada(c: Colegiatura, referencia: string, montoMXN: number, pagadoEn: number): ResultadoPagoColegiatura {
  const cobro = c.cobros.find((x) => x.referencia === referencia);
  if (!cobro) return { tipo: "no_coincide", motivo: "referencia de otro cobro" };
  if (Math.abs(cobro.montoMXN - montoMXN) > 0.001) return { tipo: "no_coincide", motivo: "monto distinto" };
  if (c.pagada) return { tipo: "duplicado", colegiatura: c };
  return { tipo: "conciliado", colegiatura: { ...c, pagada: true, pagadaEn: pagadoEn, pagadaCon: cobro.tipo } };
}

/** La familia activó CoDi (agente de adopción): ya no le toca la guía de activación. */
export function activarCodi(c: Colegiatura): Colegiatura {
  return { ...c, plan: { ...c.plan, codiActivo: true } };
}

export interface ResumenCobranza {
  familias: number;
  conCodi: number;
  pagadas: number;
  pagadasALaPrimera: number;
  cobrosCodi: number;
  montoCobradoMXN: number;
  /** Ya pasaron todos los intentos: el colegio habla con la familia. */
  paraElColegio: number;
}

export function resumen(cs: readonly Colegiatura[]): ResumenCobranza {
  const pagadas = cs.filter((c) => c.pagada);
  return {
    familias: cs.length,
    conCodi: cs.filter((c) => c.plan.codiActivo).length,
    pagadas: pagadas.length,
    pagadasALaPrimera: pagadas.filter((c) => c.pagadaCon === "cobro_dia").length,
    cobrosCodi: cs.reduce((n, c) => n + c.cobros.length, 0),
    montoCobradoMXN: pagadas.reduce((s, c) => s + montoDelPaso(c.plan, c.pagadaCon ?? "cobro_dia"), 0),
    paraElColegio: cs.filter((c) => !c.pagada && c.hechos.includes("escalar_colegio")).length,
  };
}

const MESES_SIN_ACENTO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Concepto CoDi (≤ 40, sin acentos y sin el nombre del menor): «Colegiatura enero 2027». */
export function conceptoColegiatura(c: Pick<Colegiatura, "anio" | "mes">): string {
  return `Colegiatura ${MESES_SIN_ACENTO[c.mes - 1]} ${c.anio}`;
}

/** Instante (unix s) del próximo paso de las colegiaturas que mueve la alarma real (no las de demo). */
export function proximaAlarmaColegiaturas(cs: readonly Colegiatura[], ahora: number): number | undefined {
  const ts = cs
    .filter((c) => !c.demo)
    .map((c) => siguientePaso({ ...c, reloj: Math.max(c.reloj, ahora) })?.en)
    .filter((x): x is number => x !== undefined);
  return ts.length ? Math.min(...ts) : undefined;
}

/** Versión para el navegador: el celular va enmascarado. */
export function publica(c: Colegiatura): Colegiatura {
  return { ...c, plan: { ...c.plan, celular: "••••••" + c.plan.celular.slice(-2) } };
}
