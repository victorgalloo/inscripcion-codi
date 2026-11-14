/**
 * Endpoint de WhatsApp Flows (data_exchange) — «Cobrar con CoDi» desde WhatsApp.
 *
 * Así habla Meta con el endpoint de un Flow (WhatsApp Business Platform · Cloud API,
 * data_api_version 3.0; ver developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint):
 *
 *   POST {endpoint}
 *   X-Hub-Signature-256: sha256=<hex(HMAC-SHA256(app secret de Meta, cuerpo))>
 *   { "encrypted_flow_data": b64, "encrypted_aes_key": b64, "initial_vector": b64 }
 *
 *   1. encrypted_aes_key = RSA-OAEP(SHA-256, MGF1 SHA-256) con la LLAVE PÚBLICA del negocio
 *      (la sube el negocio a Meta) de una llave AES-128 nueva por cada solicitud.
 *   2. encrypted_flow_data = AES-128-GCM(llave AES, IV de 16 bytes) del JSON; la etiqueta
 *      de 16 bytes va pegada al final.
 *   3. La respuesta va cifrada con la MISMA llave AES y el IV invertido (cada byte XOR 0xFF),
 *      en base64, como text/plain.
 *   Códigos: 421 = no se pudo descifrar (el cliente vuelve a bajar la llave pública) ·
 *            432 = firma inválida · 427 = flow_token ya no es válido.
 *
 * Aquí el cifrado y la firma son los de Meta, hechos con WebCrypto. Lo SIMULADO es el
 * otro lado: en la demo no hay app de Meta ni número de WhatsApp Business; el Worker
 * hace de cliente de WhatsApp (`cifrarComoWhatsApp`, `firmarMeta`) con una llave de demo.
 */
import { CONCEPTO_MAX, enmascararCelular } from "./pagos/tipos.ts";

// ───────────────────────── base64 / bytes ─────────────────────────

export function b64ABytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesAB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function igualesEnTiempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ───────────────────────── firma X-Hub-Signature-256 ─────────────────────────

/** Firma de Meta: `sha256=` + hex(HMAC-SHA256(app secret, cuerpo crudo)). */
export async function firmarMeta(appSecret: string, cuerpo: string): Promise<string> {
  const llave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await crypto.subtle.sign("HMAC", llave, new TextEncoder().encode(cuerpo));
  return "sha256=" + hex(new Uint8Array(firma));
}

export async function verificarFirmaMeta(appSecret: string, encabezado: string | null, cuerpo: string): Promise<boolean> {
  if (!encabezado?.startsWith("sha256=")) return false;
  return igualesEnTiempoConstante(encabezado.toLowerCase(), await firmarMeta(appSecret, cuerpo));
}

// ───────────────────────── llaves RSA ─────────────────────────

/**
 * Llave privada del negocio en PEM PKCS#8 («BEGIN PRIVATE KEY») o en base64 del DER.
 * Meta sugiere `openssl genrsa`, que da PKCS#1; WebCrypto pide PKCS#8:
 *   openssl pkcs8 -topk8 -nocrypt -in privada.pem -out privada-pkcs8.pem
 */
export async function importarLlavePrivada(pemOBase64: string): Promise<CryptoKey> {
  if (pemOBase64.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("La llave está en PKCS#1: conviértela a PKCS#8 (openssl pkcs8 -topk8 -nocrypt)");
  }
  const der = b64ABytes(pemOBase64.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  // extraíble solo para derivar la pública (n, e); nunca sale del Worker.
  return crypto.subtle.importKey("pkcs8", der, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
}

/** Pública a partir de la privada (n y e del JWK): es la que el negocio sube a Meta. */
export async function llavePublicaDe(privada: CryptoKey): Promise<CryptoKey> {
  const jwk = (await crypto.subtle.exportKey("jwk", privada)) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true },
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );
}

// ───────────────────────── cifrado ─────────────────────────

export interface CuerpoCifrado {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

export class ErrorDescifrado extends Error {}

const invertirIV = (iv: Uint8Array) => iv.map((b) => b ^ 0xff);

const llaveAES = (crudo: Uint8Array<ArrayBuffer>, usos: ("encrypt" | "decrypt")[]) =>
  crypto.subtle.importKey("raw", crudo, { name: "AES-GCM" }, false, usos);

/** Lado del NEGOCIO: descifra la solicitud que manda WhatsApp. */
export async function descifrarSolicitud(
  privada: CryptoKey,
  cuerpo: CuerpoCifrado,
): Promise<{ payload: unknown; llave: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }> {
  try {
    const llave = new Uint8Array(
      await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privada, b64ABytes(cuerpo.encrypted_aes_key)),
    );
    if (llave.length !== 16) throw new Error("la llave AES debe ser de 128 bits");
    const iv = b64ABytes(cuerpo.initial_vector);
    const claro = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      await llaveAES(llave, ["decrypt"]),
      b64ABytes(cuerpo.encrypted_flow_data),
    );
    return { payload: JSON.parse(new TextDecoder().decode(claro)), llave, iv };
  } catch (e) {
    throw new ErrorDescifrado((e as Error).message || "no se pudo descifrar");
  }
}

/** Lado del NEGOCIO: cifra la respuesta con la misma llave AES y el IV invertido. */
export async function cifrarRespuesta(respuesta: unknown, llave: Uint8Array<ArrayBuffer>, iv: Uint8Array): Promise<string> {
  const cifrado = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: invertirIV(iv), tagLength: 128 },
    await llaveAES(llave, ["encrypt"]),
    new TextEncoder().encode(JSON.stringify(respuesta)),
  );
  return bytesAB64(new Uint8Array(cifrado));
}

/** SOLO DEMO — lo que hace el cliente de WhatsApp: llave AES nueva, IV nuevo, RSA-OAEP con la pública. */
export async function cifrarComoWhatsApp(
  publica: CryptoKey,
  payload: unknown,
): Promise<{ cuerpo: CuerpoCifrado; llave: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }> {
  const llave = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const datos = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    await llaveAES(llave, ["encrypt"]),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const llaveCifrada = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publica, llave);
  return {
    cuerpo: {
      encrypted_flow_data: bytesAB64(new Uint8Array(datos)),
      encrypted_aes_key: bytesAB64(new Uint8Array(llaveCifrada)),
      initial_vector: bytesAB64(iv),
    },
    llave,
    iv,
  };
}

/** SOLO DEMO — el cliente de WhatsApp descifra la respuesta del negocio. */
export async function descifrarRespuestaComoWhatsApp(b64: string, llave: Uint8Array<ArrayBuffer>, iv: Uint8Array): Promise<unknown> {
  const claro = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: invertirIV(iv), tagLength: 128 },
    await llaveAES(llave, ["decrypt"]),
    b64ABytes(b64),
  );
  return JSON.parse(new TextDecoder().decode(claro));
}

// ───────────────────────── protocolo ─────────────────────────

export interface SolicitudFlow {
  version: string;
  action: "INIT" | "BACK" | "data_exchange" | "ping";
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
}

export interface RespuestaFlow {
  screen?: string;
  data: Record<string, unknown>;
}

/** Lo que decide la lógica de negocio: una respuesta para el Flow o «este flow_token ya no sirve» (427). */
export type Decision = { respuesta: RespuestaFlow } | { tokenInvalido: string };

export interface ResultadoHttp {
  status: number;
  cuerpo: string;
  tipo: "text/plain" | "application/json";
}

const jsonHttp = (status: number, data: unknown): ResultadoHttp => ({
  status,
  cuerpo: JSON.stringify(data),
  tipo: "application/json",
});

/**
 * Endpoint completo: firma → descifrado → ping / aviso de error / lógica → respuesta cifrada.
 * Sin red ni storage: el Worker le pasa la lógica de negocio en `manejar`.
 */
export async function procesarFlow(
  req: { cuerpo: string; firma: string | null },
  deps: { appSecret: string; llavePrivada: CryptoKey; manejar: (s: SolicitudFlow) => Promise<Decision> },
): Promise<ResultadoHttp> {
  if (!(await verificarFirmaMeta(deps.appSecret, req.firma, req.cuerpo))) {
    return jsonHttp(432, { error: "X-Hub-Signature-256 inválida" });
  }
  let cuerpo: CuerpoCifrado;
  try {
    cuerpo = JSON.parse(req.cuerpo) as CuerpoCifrado;
    if (!cuerpo.encrypted_aes_key || !cuerpo.encrypted_flow_data || !cuerpo.initial_vector) throw new Error();
  } catch {
    return jsonHttp(421, { error: "Faltan encrypted_flow_data, encrypted_aes_key o initial_vector" });
  }
  let d;
  try {
    d = await descifrarSolicitud(deps.llavePrivada, cuerpo);
  } catch {
    // 421: el cliente de WhatsApp vuelve a bajar la llave pública y reintenta.
    return jsonHttp(421, { error: "No se pudo descifrar la solicitud" });
  }
  const s = d.payload as SolicitudFlow;
  let respuesta: RespuestaFlow;
  if (s.action === "ping") {
    respuesta = { data: { status: "active" } }; // health check de WhatsApp
  } else if (s.data && typeof s.data.error === "string") {
    respuesta = { data: { acknowledged: true } }; // aviso de error del cliente
  } else {
    const decision = await deps.manejar(s);
    if ("tokenInvalido" in decision) return jsonHttp(427, { error_msg: decision.tokenInvalido });
    respuesta = decision.respuesta;
  }
  return { status: 200, cuerpo: await cifrarRespuesta(respuesta, d.llave, d.iv), tipo: "text/plain" };
}

// ───────────────────────── formulario «Cobrar con CoDi» ─────────────────────────

export interface ContactoDemo {
  id: string;
  nombre: string;
  /** Ficticio: empieza con 0000 (ningún celular mexicano real empieza con 0). */
  celular: string;
}

/** Contactos de la demo. Todo es inventado. */
export const CONTACTOS_DEMO: ContactoDemo[] = [
  { id: "mariana", nombre: "Mariana López (demo)", celular: "0000000101" },
  { id: "jorge", nombre: "Jorge Ramírez (demo)", celular: "0000000102" },
  { id: "lucia", nombre: "Lucía Torres (demo)", celular: "0000000103" },
];

/** Vigencias que ofrece el formulario (dentro de los 30–60 min del proyecto). */
export const VIGENCIAS_MIN = [30, 60] as const;

/**
 * Tope de la demo: $12,000, por debajo de 1,500 UDIS (Mediana Cuantía, CUB art. 314),
 * para que el banco del pagador no pida pasos extra. Con Pey real el tope lo pone CoDi.
 */
export const MONTO_MAX_CONTACTO = 12_000;

/** Pantalla del Flow y datos iniciales (respuesta a INIT). Ver docs/whatsapp-flow.json. */
export const PANTALLA_COBRO = "COBRO";

export function datosPantallaCobro(contactos = CONTACTOS_DEMO): Record<string, unknown> {
  return {
    contactos: [
      ...contactos.map((c) => ({ id: c.id, title: c.nombre, description: enmascararCelular(c.celular) })),
      { id: "otro", title: "Otro número (10 dígitos)" },
    ],
    vigencias: VIGENCIAS_MIN.map((m) => ({ id: String(m), title: `${m} min` })),
    concepto_max: CONCEPTO_MAX,
  };
}

/** Concepto para la orden SPEI: sin acentos ni símbolos raros (no todos los bancos los muestran). */
export function limpiarConcepto(concepto: string): string {
  return concepto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 .,\-/#()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FormularioValido {
  ok: true;
  contacto: { nombre: string; celular: string };
  montoMXN: number;
  concepto: string;
  vigenciaSegundos: number;
}

export type ResultadoFormulario = FormularioValido | { ok: false; campo: string; error: string };

/**
 * Valida lo que mandó el formulario (todo llega como texto). `soloFicticios`: en la demo
 * pública solo se aceptan números que empiezan con 0000, para que nadie escriba uno real.
 */
export function validarFormularioCobro(
  data: Record<string, unknown>,
  opciones: { contactos?: ContactoDemo[]; soloFicticios?: boolean } = {},
): ResultadoFormulario {
  const contactos = opciones.contactos ?? CONTACTOS_DEMO;
  const mal = (campo: string, error: string): ResultadoFormulario => ({ ok: false, campo, error });

  const montoTexto = String(data.monto ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(montoTexto)) return mal("monto", "Escribe el monto en pesos, con máximo dos decimales");
  const montoMXN = Number(montoTexto);
  if (!(montoMXN > 0)) return mal("monto", "El monto debe ser mayor a $0");
  if (montoMXN > MONTO_MAX_CONTACTO) return mal("monto", "En la demo, el monto máximo es $12,000.00");

  const original = String(data.concepto ?? "").trim();
  if (!original) return mal("concepto", "Escribe el concepto del cobro");
  if (original.length > CONCEPTO_MAX) return mal("concepto", `El concepto admite máximo ${CONCEPTO_MAX} caracteres`);
  const concepto = limpiarConcepto(original);
  if (!concepto) return mal("concepto", "El concepto debe llevar letras o números");

  let contacto: { nombre: string; celular: string };
  const escrito = String(data.celular ?? "").replace(/[\s-]/g, "");
  const elegido = String(data.contacto ?? "");
  if (elegido === "otro" || (!elegido && escrito)) {
    if (!/^\d{10}$/.test(escrito)) return mal("celular", "El celular debe tener 10 dígitos");
    if (opciones.soloFicticios && !escrito.startsWith("0000")) {
      return mal("celular", "En la demo usa un número ficticio que empiece con 0000");
    }
    contacto = { nombre: `Contacto ${enmascararCelular(escrito)}`, celular: escrito };
  } else {
    const c = contactos.find((x) => x.id === elegido);
    if (!c) return mal("contacto", "Elige un contacto o escribe su número");
    contacto = { nombre: c.nombre, celular: c.celular };
  }

  const vigencia = Number(data.vigencia);
  if (!(VIGENCIAS_MIN as readonly number[]).includes(vigencia)) return mal("vigencia", "La vigencia debe ser de 30 o 60 minutos");

  return { ok: true, contacto, montoMXN, concepto, vigenciaSegundos: vigencia * 60 };
}

// ───────────────────────── flow_token ─────────────────────────

/**
 * El flow_token lo genera el NEGOCIO al mandar el mensaje de Flow (Cloud API) y WhatsApp lo
 * devuelve en cada solicitud: es la sesión. Aquí: `<escuela>.<32 hex al azar>` (impredecible).
 */
export function nuevoFlowToken(escuela: string): string {
  return `${escuela}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

export function escuelaDeFlowToken(token: unknown): string | undefined {
  const m = /^(demo-[a-z0-9]{8,24})\.[0-9a-f]{32}$/.exec(String(token ?? ""));
  return m?.[1];
}
