/**
 * Verificación de webhooks con Standard Webhooks (https://www.standardwebhooks.com),
 * el esquema que usa Pey para firmar sus notificaciones.
 *
 *   webhook-id:        id único del mensaje (llave de idempotencia)
 *   webhook-timestamp: unix en segundos
 *   webhook-signature: "v1,<base64(HMAC-SHA256(secreto, `${id}.${timestamp}.${cuerpo}`))>"
 *                      (puede traer varias firmas separadas por espacio)
 *   secreto:           "whsec_<base64>"
 *
 * Solo usa WebCrypto, así corre igual en Cloudflare Workers y en Node.
 */

const TOLERANCIA_SEGUNDOS = 5 * 60;

function base64ABytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesABase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function hmac(secreto: string, contenido: string): Promise<string> {
  const llave = await crypto.subtle.importKey(
    "raw",
    base64ABytes(secreto.startsWith("whsec_") ? secreto.slice(6) : secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await crypto.subtle.sign("HMAC", llave, new TextEncoder().encode(contenido));
  return bytesABase64(new Uint8Array(firma));
}

function igualesEnTiempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Firma un cuerpo como lo haría Pey. Lo usa el modo demo para emitir webhooks simulados. */
export async function firmarWebhook(
  secreto: string,
  id: string,
  timestamp: number,
  cuerpo: string,
): Promise<string> {
  return "v1," + (await hmac(secreto, `${id}.${timestamp}.${cuerpo}`));
}

export type ResultadoVerificacion =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; motivo: string };

export async function verificarWebhook(
  secreto: string,
  encabezados: Headers,
  cuerpo: string,
  ahora: number = Math.floor(Date.now() / 1000),
): Promise<ResultadoVerificacion> {
  const id = encabezados.get("webhook-id");
  const ts = encabezados.get("webhook-timestamp");
  const firmas = encabezados.get("webhook-signature");
  if (!id || !ts || !firmas) return { ok: false, motivo: "Faltan encabezados webhook-*" };
  const timestamp = Number(ts);
  if (!Number.isInteger(timestamp)) return { ok: false, motivo: "webhook-timestamp inválido" };
  if (Math.abs(ahora - timestamp) > TOLERANCIA_SEGUNDOS) {
    return { ok: false, motivo: "webhook-timestamp fuera de tolerancia" };
  }
  const esperada = await hmac(secreto, `${id}.${timestamp}.${cuerpo}`);
  for (const f of firmas.split(" ")) {
    const [version, valor] = f.split(",", 2);
    if (version === "v1" && valor && igualesEnTiempoConstante(valor, esperada)) {
      return { ok: true, id, timestamp };
    }
  }
  return { ok: false, motivo: "Firma inválida" };
}
