import { test } from "node:test";
import assert from "node:assert/strict";
import { firmarWebhook, verificarWebhook } from "../src/webhooks.ts";

// Secreto de PRUEBA (no es el del Worker): "whsec_" + base64("solo-para-tests-0123456789abcdef").
const SECRETO = "whsec_" + btoa("solo-para-tests-0123456789abcdef");
const cuerpo = JSON.stringify({ type: "codi.pn.payment_received", amount: 4850 });

async function encabezados(ts: number, secreto = SECRETO, body = cuerpo) {
  return new Headers({
    "webhook-id": "msg_1",
    "webhook-timestamp": String(ts),
    "webhook-signature": await firmarWebhook(secreto, "msg_1", ts, body),
  });
}

test("acepta una firma válida", async () => {
  const ts = 1_800_000_000;
  const r = await verificarWebhook(SECRETO, await encabezados(ts), cuerpo, ts + 10);
  assert.deepEqual(r, { ok: true, id: "msg_1", timestamp: ts });
});

test("coincide con el vector de ejemplo de Standard Webhooks", async () => {
  // Vector publicado en github.com/standard-webhooks/standard-webhooks (spec).
  const firma = await firmarWebhook(
    "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    "msg_p5jXN8AQM9LWM0D4loKWxJek",
    1614265330,
    '{"test": 2432232314}',
  );
  assert.equal(firma, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("rechaza cuerpo alterado", async () => {
  const ts = 1_800_000_000;
  const r = await verificarWebhook(SECRETO, await encabezados(ts), cuerpo.replace("4850", "1"), ts);
  assert.equal(r.ok, false);
});

test("rechaza otro secreto", async () => {
  const ts = 1_800_000_000;
  const otro = "whsec_" + btoa("otro-secreto-cualquiera-00000000");
  const r = await verificarWebhook(SECRETO, await encabezados(ts, otro), cuerpo, ts);
  assert.equal(r.ok, false);
});

test("rechaza timestamps viejos (replay)", async () => {
  const ts = 1_800_000_000;
  const r = await verificarWebhook(SECRETO, await encabezados(ts), cuerpo, ts + 3600);
  assert.deepEqual(r, { ok: false, motivo: "webhook-timestamp fuera de tolerancia" });
});

test("rechaza si faltan encabezados", async () => {
  const r = await verificarWebhook(SECRETO, new Headers(), cuerpo);
  assert.equal(r.ok, false);
});
