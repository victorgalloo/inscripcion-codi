/** Elige el proveedor de CoDi según la configuración del Worker. */
import { PagosCoDiMock } from "./mock.ts";
import { PagosCoDiPey } from "./pey.ts";
import type { PagosCoDi } from "./tipos.ts";

/** Binding `secrets_store_secrets` de Cloudflare (Secrets Store): el valor se lee con get(). */
export interface SecretoBoveda {
  get(): Promise<string>;
}

export interface EnvPagos {
  PAGOS_PROVEEDOR: "mock" | "pey";
  /** API key como `wrangler secret` (texto). */
  PEY_API_KEY?: string;
  /** API key desde la bóveda (Secrets Store `superleads`): la ligada a la CLABE de pruebas de pey. */
  PEY_API_KEY_TEST?: SecretoBoveda;
  /** bankAccountId de la CLABE del colegio en Pey: el dinero cae directo ahí. */
  PEY_BANK_ACCOUNT_ID?: string;
}

/** La API key: primero el secreto de texto; si no, la de la bóveda (se lee al primer uso). */
export function llavePey(env: EnvPagos): string | (() => Promise<string>) {
  if (env.PEY_API_KEY) return env.PEY_API_KEY;
  const boveda = env.PEY_API_KEY_TEST;
  return boveda ? () => boveda.get() : "";
}

export function crearPagos(env: EnvPagos): PagosCoDi {
  if (env.PAGOS_PROVEEDOR === "pey") {
    return new PagosCoDiPey({ apiKey: llavePey(env), cuentaColegio: env.PEY_BANK_ACCOUNT_ID });
  }
  return new PagosCoDiMock();
}

/** Secreto de los webhooks (whsec_…): texto o bóveda. */
export async function secretoWebhook(env: {
  CODI_WEBHOOK_SECRET?: string;
  PEY_WEBHOOK_SECRET_TEST?: SecretoBoveda;
}): Promise<string | undefined> {
  if (env.CODI_WEBHOOK_SECRET) return env.CODI_WEBHOOK_SECRET;
  return env.PEY_WEBHOOK_SECRET_TEST ? await env.PEY_WEBHOOK_SECRET_TEST.get() : undefined;
}
