import { test } from "node:test";
import assert from "node:assert/strict";
import { PagosCoDiPey, ErrorPey, interpretarEventoPey } from "../src/pagos/pey.ts";
import { PagosCoDiMock } from "../src/pagos/mock.ts";
import type { SolicitudCobro } from "../src/pagos/tipos.ts";

const solicitud: SolicitudCobro = {
  montoMXN: 4850,
  concepto: "Inscripcion 2027-28 1o primaria",
  referencia: "1234567",
  vigenciaSegundos: 1800,
  metadatos: { escuelaId: "demo-abcdefgh", leadId: "lead-1" },
};

function fetchFalso(respuesta: unknown, status = 200) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    llamadas.push({ url, init });
    return new Response(JSON.stringify(respuesta), { status });
  };
  return { llamadas, fetcher };
}

test("Pey: crearCobroPush manda POST /codi/pn con el contrato de la OpenAPI", async () => {
  const { llamadas, fetcher } = fetchFalso({ transactionId: "01TX", codiId: "12345678901234567890" });
  const pey = new PagosCoDiPey({ apiKey: "clave-de-prueba", fetcher, ahora: () => 1000 });
  const c = await pey.crearCobroPush("0000000042", solicitud);
  assert.equal(llamadas[0]!.url, "https://api.pey.mx/codi/pn");
  const h = llamadas[0]!.init!.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer clave-de-prueba");
  assert.deepEqual(JSON.parse(String(llamadas[0]!.init!.body)), {
    amount: 4850,
    phoneNumber: "0000000042",
    concept: "Inscripcion 2027-28 1o primaria",
    expiration: 1800,
    numRef: "1234567",
    metadata: { escuelaId: "demo-abcdefgh", leadId: "lead-1" },
  });
  assert.equal(c.transaccionId, "01TX");
  assert.equal(c.folioCodi, "12345678901234567890");
  assert.equal(c.celular, "•• •••• ••42");
  assert.equal(c.expiraEn, 2800);
});

test("Pey: crearCobroQR manda POST /codi/qr y devuelve qrString", async () => {
  const { llamadas, fetcher } = fetchFalso({ id: "AB12CD34EF", qrString: "{}" }, 201);
  const pey = new PagosCoDiPey({ apiKey: "k", fetcher });
  const c = await pey.crearCobroQR(solicitud);
  assert.equal(llamadas[0]!.url, "https://api.pey.mx/codi/qr");
  assert.equal(JSON.parse(String(llamadas[0]!.init!.body)).generateImage, false);
  assert.equal(c.id, "AB12CD34EF");
});

test("Pey: traduce errores de la API", async () => {
  const { fetcher } = fetchFalso({ error: { type: "INVALID_STATE", message: "API key does not have CoDi enabled", requestId: "r1" } }, 400);
  const pey = new PagosCoDiPey({ apiKey: "k", fetcher });
  await assert.rejects(pey.crearCobroPush("0000000042", solicitud), (e: unknown) => e instanceof ErrorPey && e.tipo === "INVALID_STATE");
});

test("Pey: consultarTransaccion mapea PAID → PAGADO", async () => {
  const { fetcher } = fetchFalso({ id: "01TX", status: "PAID", amount: 4850, datePaid: 5 });
  const r = await new PagosCoDiPey({ apiKey: "k", fetcher }).consultarTransaccion("01TX");
  assert.deepEqual(r, { id: "01TX", estado: "PAGADO", montoMXN: 4850, pagadoEn: 5 });
});

test("validaciones CoDi: celular, referencia, vigencia, monto", async () => {
  const m = new PagosCoDiMock();
  await assert.rejects(m.crearCobroPush("55", solicitud));
  await assert.rejects(m.crearCobroQR({ ...solicitud, referencia: "12345678" }));
  await assert.rejects(m.crearCobroQR({ ...solicitud, vigenciaSegundos: 60 }));
  await assert.rejects(m.crearCobroQR({ ...solicitud, montoMXN: 0 }));
  await assert.rejects(m.crearCobroQR({ ...solicitud, montoMXN: 10.005 }));
  await m.crearCobroQR({ ...solicitud, montoMXN: 0.1 });
});

test("interpreta el webhook de ejemplo de la documentación de Pey (push)", () => {
  const p = interpretarEventoPey({
    amount: 100,
    apiKeyId: "01M3QMMR6X9CBVDY1SF3G8QWNW",
    concept: "(dev) Order 45",
    datePaid: 1790724758,
    metadata: { trackingKey: "0192191042", externalMetadata: { orderId: "12345" } },
    numRef: "4567",
    transactionId: "01M3QR5E7XHXMNZDEPFH3JAWS0",
    type: "codi.pn.payment_received",
  });
  assert.equal(p.medio, "push");
  assert.equal(p.claveRastreo, "0192191042");
  assert.deepEqual(p.metadatos, { orderId: "12345" });
});

test("rechaza eventos desconocidos", () => {
  assert.throws(() => interpretarEventoPey({ type: "otra.cosa", amount: 1, transactionId: "x" }));
});

test("mock: aceptar un push produce un webhook con la forma de Pey", async () => {
  const m = new PagosCoDiMock();
  const c = await m.crearCobroPush("0000000042", solicitud);
  const ev = m.simularAceptacion({ medio: "push", ...c, id: c.transaccionId }, solicitud.metadatos);
  assert.equal(ev.type, "codi.pn.payment_received");
  assert.equal(ev.transactionId, c.transaccionId);
  const p = m.interpretarWebhook(ev);
  assert.equal(p.montoMXN, 4850);
  assert.equal(p.metadatos.leadId, "lead-1");
  assert.equal((await m.consultarTransaccion(c.transaccionId)).estado, "PAGADO");
});
