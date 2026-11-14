#!/usr/bin/env node
// Envía a /webhooks/codi un webhook CoDi firmado con Standard Webhooks, igual que lo haría Pey.
//
//   CODI_WEBHOOK_SECRET=whsec_… node scripts/enviar-webhook.mjs \
//     --url http://localhost:8787 --escuela demo-xxxxxxxx --lead lead-xxxx --ref 1234567 --monto 4850 [--medio push|qr]
//
// El secreto se lee SOLO de la variable de entorno; nunca lo pongas en un archivo del repo.
import { createHmac, randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
const secreto = process.env.CODI_WEBHOOK_SECRET;
if (!secreto || !args.url || !args.escuela || !args.ref || !args.monto) {
  console.error("Uso: CODI_WEBHOOK_SECRET=whsec_… node scripts/enviar-webhook.mjs --url URL --escuela ID --ref REF --monto MXN [--lead ID] [--medio push|qr]");
  process.exit(1);
}
const medio = args.medio === "qr" ? "qr" : "push";
const ahora = Math.floor(Date.now() / 1000);
const evento = {
  type: medio === "push" ? "codi.pn.payment_received" : "codi.qr.payment_received",
  amount: Number(args.monto),
  apiKeyId: "DEMO0000000000000000000000",
  concept: "Inscripcion 2027-28 1o primaria",
  datePaid: ahora,
  numRef: String(args.ref),
  transactionId: "DEMO-SCRIPT-" + randomUUID().slice(0, 8),
  metadata: {
    clabe: "000000000000000000",
    trackingKey: "DEMOSCRIPT" + String(ahora).slice(-4),
    externalMetadata: { escuelaId: args.escuela, ...(args.lead ? { leadId: args.lead } : {}) },
  },
};
const cuerpo = JSON.stringify(evento);
const id = "msg_script_" + randomUUID();
const llave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
const firma = createHmac("sha256", llave).update(`${id}.${ahora}.${cuerpo}`).digest("base64");

const res = await fetch(new URL("/webhooks/codi", args.url), {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(ahora),
    "webhook-signature": `v1,${firma}`,
  },
  body: cuerpo,
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
