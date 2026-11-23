/**
 * Reglas del modo «pey» (API real) para que la demo no cobre de más ni a desconocidos.
 *
 * - Monto: en modo pey se cobra PEY_MONTO_PRUEBA_MXN (p. ej. "0.01") en vez de la cuota ficticia
 *   de $4,850, mientras la cuenta receptora sea la CLABE de pruebas de pey (lo pagado no se devuelve).
 * - Push: en modo pey SOLO va al celular de prueba configurado (secreto PEY_CELULAR_PRUEBA, el de quien
 *   prueba). El celular ficticio de la demo nunca recibe un push real, y sin celular de prueba solo hay QR.
 */
import { CUOTA_INSCRIPCION, ESCUELA_DEMO } from "./demo.ts";

export interface EnvModo {
  PAGOS_PROVEEDOR: "mock" | "pey";
  PEY_MONTO_PRUEBA_MXN?: string;
  PEY_CELULAR_PRUEBA?: string;
  /** Titular real de la CLABE ligada a la API key: es el «Beneficiario» que ve quien paga. */
  PEY_BENEFICIARIO?: string;
}

/** El beneficiario que se le dice a la familia debe ser el titular REAL de la CLABE que cobra. */
export function beneficiarioSegunModo(env: EnvModo): string {
  if (env.PAGOS_PROVEEDOR !== "pey") return ESCUELA_DEMO.razonSocial;
  return env.PEY_BENEFICIARIO || "Titular de la CLABE ligada a la API key de pey";
}

export function cuotaSegunModo(env: EnvModo): typeof CUOTA_INSCRIPCION {
  if (env.PAGOS_PROVEEDOR !== "pey" || !env.PEY_MONTO_PRUEBA_MXN) return CUOTA_INSCRIPCION;
  const monto = Number(env.PEY_MONTO_PRUEBA_MXN);
  if (!(Number.isFinite(monto) && monto > 0)) throw new Error("PEY_MONTO_PRUEBA_MXN inválido");
  return { ...CUOTA_INSCRIPCION, montoMXN: monto, concepto: "Prueba Inscrito (apartado)" };
}

/** A qué celular va el push. `undefined` = push no permitido en este modo. */
export function celularDestino(env: EnvModo, celularDelLead: string): string | undefined {
  if (env.PAGOS_PROVEEDOR !== "pey") return celularDelLead;
  const c = (env.PEY_CELULAR_PRUEBA ?? "").replace(/\D/g, "");
  return /^[0-9]{10}$/.test(c) ? c : undefined;
}
