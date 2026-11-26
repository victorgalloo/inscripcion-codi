/**
 * FacturacionHttp — adaptador GENÉRICO para cualquier proveedor de timbrado por HTTP.
 *
 * No conoce a ningún proveedor: manda el contrato canónico de src/facturacion/tipos.ts
 * (`SolicitudFactura`, JSON) y espera de vuelta la respuesta canónica (`Factura`). Todo se
 * configura con variables del Worker:
 *
 *   FACTURACION_URL             base, p. ej. https://facturas.ejemplo.invalid/v1
 *   FACTURACION_API_KEY         secreto de texto o binding de la bóveda
 *   FACTURACION_AUTH_CABECERA   cabecera de autenticación        (por defecto «Authorization»)
 *   FACTURACION_AUTH_PREFIJO    prefijo del valor                 (por defecto «Bearer »; "" = la llave sola)
 *   FACTURACION_RUTA_EMITIR     POST                              (por defecto /facturas)
 *   FACTURACION_RUTA_CONSULTAR  GET                               (por defecto /facturas/{id})
 *   FACTURACION_RUTA_CANCELAR   POST                              (por defecto /facturas/{id}/cancelar)
 *   FACTURACION_RUTA_ARCHIVO    GET                               (por defecto /facturas/{id}/{formato})
 *
 * Conectar un proveedor concreto = poner un traductor delgado detrás de FACTURACION_URL
 * (recibe este contrato y habla el dialecto del proveedor), o escribir una clase nueva que
 * implemente `Facturacion`. Ni el agente facturador ni las rutas /api/facturas cambian.
 *
 * Errores: 408, 429 y 5xx (o la red) son reintentables; el resto (4xx) no. El agente
 * facturador decide cuántas veces reintentar (src/facturador.ts).
 */
import type { Facturacion, Factura, SolicitudCancelacion, SolicitudFactura } from "./tipos.ts";
import { validarCancelacion } from "./tipos.ts";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface RutasFacturacion {
  emitir: string;
  consultar: string;
  cancelar: string;
  archivo: string;
}

export const RUTAS_POR_DEFECTO: RutasFacturacion = {
  emitir: "/facturas",
  consultar: "/facturas/{id}",
  cancelar: "/facturas/{id}/cancelar",
  archivo: "/facturas/{id}/{formato}",
};

export class ErrorFacturacion extends Error {
  status: number;
  reintentable: boolean;
  constructor(status: number, mensaje: string) {
    super(mensaje);
    this.status = status;
    // status 0 = no hubo respuesta (red, DNS, timeout).
    this.reintentable = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

export interface OpcionesFacturacionHttp {
  base: string;
  /** Llave, o función que la lee (bóveda) al primer uso. */
  apiKey: string | (() => Promise<string>);
  cabecera?: string;
  prefijo?: string;
  rutas?: Partial<RutasFacturacion>;
  fetcher?: Fetcher;
}

export class FacturacionHttp implements Facturacion {
  readonly proveedor = "http" as const;
  private base: string;
  private apiKey: string | (() => Promise<string>);
  private cabecera: string;
  private prefijo: string;
  private rutas: RutasFacturacion;
  private fetcher: Fetcher;

  constructor(o: OpcionesFacturacionHttp) {
    if (!/^https?:\/\//.test(o.base)) throw new Error("FACTURACION_URL debe ser una URL http(s)");
    this.base = o.base.replace(/\/+$/, "");
    this.apiKey = o.apiKey;
    this.cabecera = o.cabecera || "Authorization";
    this.prefijo = o.prefijo ?? "Bearer ";
    this.rutas = { ...RUTAS_POR_DEFECTO, ...Object.fromEntries(Object.entries(o.rutas ?? {}).filter(([, v]) => v)) };
    this.fetcher = o.fetcher ?? ((url, init) => fetch(url, init));
  }

  private url(plantilla: string, vars: Record<string, string> = {}): string {
    const ruta = plantilla.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ""));
    return this.base + (ruta.startsWith("/") ? ruta : "/" + ruta);
  }

  private async encabezados(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const llave = typeof this.apiKey === "function" ? await this.apiKey() : this.apiKey;
    if (!llave) throw new ErrorFacturacion(401, "FACTURACION_API_KEY no configurada");
    return { [this.cabecera]: this.prefijo + llave, Accept: "application/json", ...extra };
  }

  private async pedir(metodo: "GET" | "POST", url: string, cuerpo?: unknown, extra?: Record<string, string>): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method: metodo,
        headers: await this.encabezados(cuerpo === undefined ? extra : { "Content-Type": "application/json", ...extra }),
        ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
      });
    } catch (e) {
      if (e instanceof ErrorFacturacion) throw e;
      throw new ErrorFacturacion(0, `Proveedor de facturación sin respuesta: ${(e as Error).message}`);
    }
    if (!res.ok) {
      let detalle = "";
      try {
        const j = (await res.json()) as { error?: unknown; mensaje?: unknown; message?: unknown };
        detalle = String(j.error ?? j.mensaje ?? j.message ?? "");
      } catch {
        /* cuerpo no JSON */
      }
      throw new ErrorFacturacion(res.status, `Proveedor de facturación HTTP ${res.status}${detalle ? ": " + detalle : ""}`);
    }
    return res;
  }

  private async factura(res: Response): Promise<Factura> {
    const f = (await res.json()) as Partial<Factura>;
    if (!f || typeof f.id !== "string" || !f.estado) {
      throw new ErrorFacturacion(502, "Respuesta del proveedor fuera del contrato (falta id o estado)");
    }
    return { ...(f as Factura), proveedor: "http", metadatos: f.metadatos ?? {} };
  }

  async emitir(s: SolicitudFactura): Promise<Factura> {
    // Idempotency-Key: si el proveedor la respeta, un reintento nunca timbra dos veces.
    const res = await this.pedir("POST", this.url(this.rutas.emitir), s, { "Idempotency-Key": s.llave });
    return this.factura(res);
  }

  async consultar(id: string): Promise<Factura> {
    return this.factura(await this.pedir("GET", this.url(this.rutas.consultar, { id })));
  }

  async cancelar(id: string, c: SolicitudCancelacion): Promise<Factura> {
    validarCancelacion(c);
    return this.factura(await this.pedir("POST", this.url(this.rutas.cancelar, { id }), c));
  }

  async archivo(f: Factura, formato: "pdf" | "xml") {
    const res = await this.pedir("GET", this.url(this.rutas.archivo, { id: f.id, formato }));
    const tipo = res.headers.get("Content-Type") ?? (formato === "pdf" ? "application/pdf" : "application/xml");
    return { tipo, cuerpo: new Uint8Array(await res.arrayBuffer()) };
  }
}
