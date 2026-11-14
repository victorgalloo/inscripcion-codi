/** Elige el proveedor de CoDi según la configuración del Worker. */
import { PagosCoDiMock } from "./mock.ts";
import { PagosCoDiPey } from "./pey.ts";
import type { PagosCoDi } from "./tipos.ts";

export interface EnvPagos {
  PAGOS_PROVEEDOR: "mock" | "pey";
  PEY_API_KEY?: string;
  /** bankAccountId de la CLABE del colegio en Pey: el dinero cae directo ahí. */
  PEY_BANK_ACCOUNT_ID?: string;
}

export function crearPagos(env: EnvPagos): PagosCoDi {
  if (env.PAGOS_PROVEEDOR === "pey") {
    return new PagosCoDiPey({ apiKey: env.PEY_API_KEY ?? "", cuentaColegio: env.PEY_BANK_ACCOUNT_ID });
  }
  return new PagosCoDiMock();
}
