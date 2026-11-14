import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lead } from "../src/conciliacion.ts";
import { conciliar } from "../src/conciliacion.ts";
import { ponerCobroNuevo, proximoVencimiento, revisarVencimiento } from "../src/vencimiento.ts";
import { PagosCoDiPey } from "../src/pagos/pey.ts";
import { PagosCoDiMock } from "../src/pagos/mock.ts";

const lead: Lead = {
  id: "lead-1",
  familia: "Familia Demo",
  grado: "1° primaria",
  canal: "WhatsApp",
  etapa: "cobro_enviado",
  cobro: {
    medio: "push",
    proveedor: "pey",
    id: "01TX",
    folioCodi: "12345678901234567890",
    montoMXN: 4850,
    concepto: "Inscripcion",
    referencia: "1234567",
    expiraEn: 1000,
    creadoEn: 0,
    estado: "vigente",
  },
};

function pey(respuesta: unknown, status = 200) {
  const urls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${init?.method} ${url}`);
    return new Response(JSON.stringify(respuesta), { status });
  };
  return { urls, pagos: new PagosCoDiPey({ apiKey: "clave-de-prueba", fetcher }) };
}

test("antes de la vigencia no consulta nada", async () => {
  const { urls, pagos } = pey({});
  assert.equal((await revisarVencimiento(lead, pagos, 999)).tipo, "sin_cambio");
  assert.equal(urls.length, 0);
});

test("al vencer un push consulta GET /transaction/{id}; PENDING → vencido o rechazado", async () => {
  const { urls, pagos } = pey({ id: "01TX", status: "PENDING", amount: 4850 });
  const r = await revisarVencimiento(lead, pagos, 1000);
  assert.deepEqual(urls, ["GET https://api.pey.mx/transaction/01TX"]);
  assert.equal(r.tipo, "vencido");
  assert.equal(r.tipo === "vencido" && r.lead.cobro!.estado, "vencido_o_rechazado");
  assert.equal(r.tipo === "vencido" && r.lead.etapa, "cobro_enviado"); // no se inscribe
});

test("al vencer un QR consulta GET /transaction/codi/qr/{id}", async () => {
  const { urls, pagos } = pey({ items: [] });
  const qr: Lead = { ...lead, cobro: { ...lead.cobro!, medio: "qr", id: "AB12CD34EF" } };
  assert.equal((await revisarVencimiento(qr, pagos, 2000)).tipo, "vencido");
  assert.deepEqual(urls, ["GET https://api.pey.mx/transaction/codi/qr/AB12CD34EF"]);
});

test("PAID sin webhook: se concilia con lo que reporta Pey", async () => {
  const { pagos } = pey({ id: "01TX", status: "PAID", amount: 4850, datePaid: 990, metadata: { trackingKey: "R9" } });
  const r = await revisarVencimiento(lead, pagos, 1000);
  assert.equal(r.tipo, "pagado_sin_webhook");
  if (r.tipo !== "pagado_sin_webhook") return;
  const c = conciliar([lead], r.pago, 1);
  assert.equal(c.resultado.tipo, "conciliado");
  assert.equal(c.leads[0]!.pago!.claveRastreo, "R9");
});

test("PAID por otro monto: no se inscribe, va a revisión", async () => {
  const { pagos } = pey({ id: "01TX", status: "PAID", amount: 10 });
  const r = await revisarVencimiento(lead, pagos, 1000);
  assert.equal(r.tipo, "pagado_sin_webhook");
  if (r.tipo === "pagado_sin_webhook") assert.equal(conciliar([lead], r.pago, 1).resultado.tipo, "no_coincide");
});

test("si la consulta falla, el cobro sigue vigente (se reintenta)", async () => {
  const { pagos } = pey({ error: { type: "ERROR", message: "caído" } }, 500);
  assert.equal((await revisarVencimiento(lead, pagos, 1000)).tipo, "error");
});

test("mock: sin aceptación simulada, vencer da PENDING → vencido", async () => {
  const m = new PagosCoDiMock();
  const c = await m.crearCobroPush("0000000042", {
    montoMXN: 4850, concepto: "Inscripcion", referencia: "1234567", vigenciaSegundos: 1800, metadatos: {},
  });
  const l: Lead = { ...lead, cobro: { ...lead.cobro!, proveedor: "mock", id: c.transaccionId } };
  assert.equal((await revisarVencimiento(l, m, 10_000_000_000)).tipo, "vencido");
  m.simularAceptacion({ medio: "push", ...c, id: c.transaccionId }, {});
  assert.equal((await revisarVencimiento(l, m, 10_000_000_000)).tipo, "pagado_sin_webhook");
});

test("cobro nuevo tras vencer: el viejo queda en el historial y no se reutiliza", () => {
  const vencido: Lead = { ...lead, cobro: { ...lead.cobro!, estado: "vencido_o_rechazado" } };
  const nuevo = ponerCobroNuevo(vencido, { ...lead.cobro!, id: "01TX2", referencia: "7654321", expiraEn: 5000 });
  assert.equal(nuevo.cobro!.estado, "vigente");
  assert.equal(nuevo.cobro!.referencia, "7654321");
  assert.deepEqual(nuevo.cobrosAnteriores!.map((c) => [c.id, c.estado]), [["01TX", "vencido_o_rechazado"]]);
  // Un cobro vigente que se reemplaza (p. ej. por el QR) queda «sustituido».
  const otra = ponerCobroNuevo(nuevo, { ...lead.cobro!, medio: "qr", id: "IDC", referencia: "1111111" });
  assert.equal(otra.cobrosAnteriores!.at(-1)!.estado, "sustituido");
  assert.equal(proximoVencimiento([vencido, nuevo]), 5000);
});
