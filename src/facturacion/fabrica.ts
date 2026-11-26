/** Elige el proveedor de facturación y arma la configuración del colegio emisor. */
import { FacturacionHttp, type Fetcher } from "./http.ts";
import { FacturacionMock } from "./mock.ts";
import type { SecretoBoveda } from "../pagos/fabrica.ts";
import type { ClavesProdServ, Emisor, EnvFacturacion, Facturacion, NivelEducativo } from "./tipos.ts";

/** Texto o bóveda (Secrets Store), igual que `llavePey`: la bóveda se lee al primer uso. */
export function llaveTextoOBoveda(v: string | SecretoBoveda | undefined): string | (() => Promise<string>) {
  if (typeof v === "string") return v;
  return v ? () => v.get() : "";
}

export function crearFacturacion(env: EnvFacturacion, opciones: { fetcher?: Fetcher } = {}): Facturacion {
  if (env.FACTURACION_PROVEEDOR === "http") {
    if (!env.FACTURACION_URL) throw new Error("FACTURACION_URL no configurada");
    return new FacturacionHttp({
      base: env.FACTURACION_URL,
      apiKey: llaveTextoOBoveda(env.FACTURACION_API_KEY),
      cabecera: env.FACTURACION_AUTH_CABECERA,
      prefijo: env.FACTURACION_AUTH_PREFIJO,
      rutas: {
        emitir: env.FACTURACION_RUTA_EMITIR,
        consultar: env.FACTURACION_RUTA_CONSULTAR,
        cancelar: env.FACTURACION_RUTA_CANCELAR,
        archivo: env.FACTURACION_RUTA_ARCHIVO,
      },
      fetcher: opciones.fetcher,
    });
  }
  return new FacturacionMock();
}

/** Secreto de los webhooks de facturación (whsec_…): texto o bóveda. */
export async function secretoWebhookFacturacion(env: EnvFacturacion): Promise<string | undefined> {
  const v = env.FACTURACION_WEBHOOK_SECRET;
  if (typeof v === "string") return v || undefined;
  return v ? await v.get() : undefined;
}

/**
 * Emisor de la DEMO: todo ficticio. «AAA010101AAA» es el RFC de ejemplo que se usa en
 * ambientes de prueba; el régimen 601 (general de ley, personas morales) y el CP son
 * valores por defecto que cada colegio cambia por los de su constancia.
 */
export const EMISOR_DEMO: Emisor = {
  rfc: "AAA010101AAA",
  nombre: "COLEGIO AURORA (DEMO)",
  regimenFiscal: "601",
  codigoPostal: "06000",
};

export interface ConfigFacturador {
  emisor: Emisor;
  claves: ClavesProdServ;
}

export function configFacturador(env: EnvFacturacion): ConfigFacturador {
  let claves: ClavesProdServ = {};
  if (env.FACTURACION_CLAVES_PRODSERV) {
    try {
      const j = JSON.parse(env.FACTURACION_CLAVES_PRODSERV) as Record<string, unknown>;
      claves = Object.fromEntries(
        Object.entries(j).filter(([, v]) => typeof v === "string" && /^[0-9]{8}$/.test(v)),
      ) as Partial<Record<NivelEducativo, string>>;
    } catch {
      throw new Error("FACTURACION_CLAVES_PRODSERV debe ser JSON: {\"Primaria\":\"########\", …}");
    }
  }
  return {
    emisor: {
      rfc: env.FACTURACION_EMISOR_RFC || EMISOR_DEMO.rfc,
      nombre: env.FACTURACION_EMISOR_NOMBRE || EMISOR_DEMO.nombre,
      regimenFiscal: env.FACTURACION_EMISOR_REGIMEN || EMISOR_DEMO.regimenFiscal,
      codigoPostal: env.FACTURACION_EMISOR_CP || EMISOR_DEMO.codigoPostal,
    },
    claves,
  };
}
