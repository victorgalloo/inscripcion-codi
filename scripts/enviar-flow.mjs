#!/usr/bin/env node
// Manda a /webhooks/whatsapp-flow una solicitud de WhatsApp Flow cifrada y firmada, como lo haría Meta:
// baja la llave pública del Worker, cifra con RSA-OAEP-256 + AES-128-GCM, firma con X-Hub-Signature-256
// y descifra la respuesta (IV invertido).
//
//   WA_APP_SECRET=… node scripts/enviar-flow.mjs --url http://localhost:8787 [--action ping|INIT|data_exchange]
//     [--token <flow_token>] [--monto 350 --concepto "Colegiatura" --contacto mariana --vigencia 30]
//     [--firma-mala]
//
// El secreto se lee SOLO de la variable de entorno; nunca lo pongas en un archivo del repo.
import { createCipheriv, createDecipheriv, createHmac, publicEncrypt, constants, randomBytes } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]?.startsWith("--") ? true : a[i + 1] ?? true]] : acc), []),
);
const secreto = process.env.WA_APP_SECRET;
if (!secreto || !args.url) {
  console.error("Uso: WA_APP_SECRET=… node scripts/enviar-flow.mjs --url URL [--action ping|INIT|data_exchange] [--token T] …");
  process.exit(1);
}
const action = args.action ?? "ping";
const payload =
  action === "ping"
    ? { version: "3.0", action: "ping" }
    : {
        version: "3.0",
        action,
        flow_token: args.token,
        ...(action === "data_exchange"
          ? {
              screen: "COBRO",
              data: { monto: args.monto ?? "350", concepto: args.concepto ?? "Colegiatura noviembre", contacto: args.contacto ?? "mariana", celular: args.celular ?? "", vigencia: args.vigencia ?? "30" },
            }
          : {}),
      };

const publica = await (await fetch(new URL("/api/whatsapp-flow/llave-publica", args.url))).text();
const llave = randomBytes(16);
const iv = randomBytes(16);
const c = createCipheriv("aes-128-gcm", llave, iv);
const datos = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
const cuerpo = JSON.stringify({
  encrypted_flow_data: datos.toString("base64"),
  encrypted_aes_key: publicEncrypt({ key: publica, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, llave).toString("base64"),
  initial_vector: iv.toString("base64"),
});
const firma = "sha256=" + createHmac("sha256", args["firma-mala"] ? "otro-secreto" : secreto).update(cuerpo).digest("hex");

const res = await fetch(new URL("/webhooks/whatsapp-flow", args.url), {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firma },
  body: cuerpo,
});
const texto = await res.text();
console.log("HTTP", res.status, res.headers.get("content-type"));
if (res.status !== 200) {
  console.log(texto);
} else {
  const b = Buffer.from(texto, "base64");
  const d = createDecipheriv("aes-128-gcm", llave, Buffer.from(iv.map((x) => x ^ 0xff)));
  d.setAuthTag(b.subarray(-16));
  console.log("cifrada:", texto.slice(0, 24) + "…");
  console.log("descifrada:", Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString("utf8"));
}
