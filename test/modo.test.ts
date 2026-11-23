import { test } from "node:test";
import assert from "node:assert/strict";
import { beneficiarioSegunModo, celularDestino, cuotaSegunModo } from "../src/modo.ts";
import { CUOTA_INSCRIPCION } from "../src/demo.ts";
import { crearPagos, llavePey, secretoWebhook } from "../src/pagos/fabrica.ts";
import { PagosCoDiPey } from "../src/pagos/pey.ts";

test("modo mock: la cuota y el celular de la demo no cambian", () => {
  assert.deepEqual(cuotaSegunModo({ PAGOS_PROVEEDOR: "mock", PEY_MONTO_PRUEBA_MXN: "0.01" }), CUOTA_INSCRIPCION);
  assert.equal(celularDestino({ PAGOS_PROVEEDOR: "mock" }, "0000000042"), "0000000042");
});

test("modo pey: cobra el monto de prueba y el push solo va al celular de prueba", () => {
  const c = cuotaSegunModo({ PAGOS_PROVEEDOR: "pey", PEY_MONTO_PRUEBA_MXN: "0.01" });
  assert.equal(c.montoMXN, 0.01);
  assert.ok(c.concepto.length <= 40);
  assert.equal(celularDestino({ PAGOS_PROVEEDOR: "pey" }, "0000000042"), undefined);
  assert.equal(celularDestino({ PAGOS_PROVEEDOR: "pey", PEY_CELULAR_PRUEBA: "55 1234 5678" }, "0000000042"), "5512345678");
  assert.throws(() => cuotaSegunModo({ PAGOS_PROVEEDOR: "pey", PEY_MONTO_PRUEBA_MXN: "-1" }));
});

test("fábrica: en modo pey lee la API key de la bóveda al primer uso", async () => {
  let lecturas = 0;
  const boveda = { get: async () => (lecturas++, "llave-de-boveda") };
  const env = { PAGOS_PROVEEDOR: "pey" as const, PEY_API_KEY_TEST: boveda };
  assert.equal(typeof llavePey(env), "function");
  assert.ok(crearPagos(env) instanceof PagosCoDiPey);
  assert.equal(lecturas, 0);
  let auth = "";
  const pey = new PagosCoDiPey({
    apiKey: llavePey(env),
    fetcher: async (_u, init) => {
      auth = (init!.headers as Record<string, string>).Authorization!;
      return new Response(JSON.stringify({ id: "01TX", status: "PENDING", amount: 0.01 }));
    },
  });
  await pey.consultarTransaccion("01TX");
  assert.equal(auth, "Bearer llave-de-boveda");
  assert.equal(lecturas, 1);
  assert.equal(llavePey({ PAGOS_PROVEEDOR: "pey", PEY_API_KEY: "texto", PEY_API_KEY_TEST: boveda }), "texto");
});

test("secreto de webhooks: texto primero, luego bóveda", async () => {
  assert.equal(await secretoWebhook({ CODI_WEBHOOK_SECRET: "whsec_a" }), "whsec_a");
  assert.equal(await secretoWebhook({ PEY_WEBHOOK_SECRET_TEST: { get: async () => "whsec_b" } }), "whsec_b");
  assert.equal(await secretoWebhook({}), undefined);
});

test("beneficiario: en modo pey es el titular real de la CLABE, nunca el colegio ficticio", () => {
  assert.equal(beneficiarioSegunModo({ PAGOS_PROVEEDOR: "mock" }), "Colegio Aurora, S.C. (demo)");
  assert.equal(beneficiarioSegunModo({ PAGOS_PROVEEDOR: "pey", PEY_BENEFICIARIO: "Ramón" }), "Ramón");
  assert.doesNotMatch(beneficiarioSegunModo({ PAGOS_PROVEEDOR: "pey" }), /Aurora/);
});
