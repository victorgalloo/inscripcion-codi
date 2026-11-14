import { test } from "node:test";
import assert from "node:assert/strict";
import { conciliar, nuevaReferencia, type Lead } from "../src/conciliacion.ts";
import type { PagoRecibido } from "../src/pagos/tipos.ts";

const lead: Lead = {
  id: "lead-1",
  familia: "Familia Demo",
  grado: "1° primaria",
  canal: "WhatsApp",
  etapa: "cobro_enviado",
  cobro: {
    medio: "push",
    proveedor: "mock",
    id: "01TX",
    montoMXN: 4850,
    concepto: "Inscripcion",
    referencia: "1234567",
    expiraEn: 0,
    creadoEn: 0,
  },
};
const otro: Lead = { id: "lead-2", familia: "Otra", grado: "2°", canal: "WhatsApp", etapa: "informes" };

const pago: PagoRecibido = {
  medio: "push",
  transaccionId: "01TX",
  montoMXN: 4850,
  referencia: "1234567",
  concepto: "Inscripcion",
  pagadoEn: 10,
  claveRastreo: "R1",
  metadatos: {},
};

test("concilia por transacción y mueve a pagado con comisión 0", () => {
  const { leads, resultado } = conciliar([otro, lead], pago, 99);
  assert.deepEqual(resultado, { tipo: "conciliado", leadId: "lead-1" });
  const l = leads.find((x) => x.id === "lead-1")!;
  assert.equal(l.etapa, "pagado");
  assert.equal(l.pago!.comisionMXN, 0);
  assert.equal(l.pago!.claveRastreo, "R1");
  assert.equal(leads.find((x) => x.id === "lead-2")!.etapa, "informes");
});

test("concilia por referencia + monto si cambió el id (fallback QR)", () => {
  const r = conciliar([lead], { ...pago, medio: "qr", transaccionId: "OTRA", cobroId: "IDC" }, 1);
  assert.equal(r.resultado.tipo, "conciliado");
});

test("un webhook repetido no se aplica dos veces", () => {
  const una = conciliar([lead], pago, 1).leads;
  assert.equal(conciliar(una, pago, 2).resultado.tipo, "duplicado");
});

test("monto distinto manda a revisión, no a pagado", () => {
  const { leads, resultado } = conciliar([lead], { ...pago, montoMXN: 100, metadatos: { leadId: "lead-1" } }, 1);
  assert.equal(resultado.tipo, "monto_distinto");
  assert.equal(leads[0]!.etapa, "revision");
});

test("pago sin cobro conocido no toca nada", () => {
  const r = conciliar([lead, otro], { ...pago, transaccionId: "X", referencia: "7654321" }, 1);
  assert.equal(r.resultado.tipo, "sin_cobro");
  assert.equal(r.leads[1]!.etapa, "informes");
});

test("referencias de 7 dígitos sin repetir", () => {
  let n = 0;
  const azar = () => [0.0, 0.0, 0.5][n++ % 3]!; // primero choca con 1000000, luego da otra
  const ya: Lead = { ...lead, cobro: { ...lead.cobro!, referencia: "1000000" } };
  const r = nuevaReferencia([ya], azar);
  assert.match(r, /^[0-9]{7}$/);
  assert.notEqual(r, "1000000");
});
