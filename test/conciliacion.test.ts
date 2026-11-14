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

test("monto distinto se rechaza: va a revisión, no a pagado", () => {
  const { leads, resultado } = conciliar([lead], { ...pago, montoMXN: 100, metadatos: { leadId: "lead-1" } }, 1);
  assert.equal(resultado.tipo, "no_coincide");
  assert.equal(leads[0]!.etapa, "revision");
  assert.equal(leads[0]!.pago, undefined);
  assert.match(leads[0]!.nota!, /monto distinto/);
});

test("referencia distinta se rechaza aunque el monto y el lead coincidan", () => {
  const { leads, resultado } = conciliar([lead], { ...pago, referencia: "7654321", metadatos: { leadId: "lead-1" } }, 1);
  assert.deepEqual(resultado, {
    tipo: "no_coincide",
    leadId: "lead-1",
    motivo: "referencia distinta",
    esperado: { montoMXN: 4850, referencia: "1234567" },
    recibido: { montoMXN: 4850, referencia: "7654321" },
  });
  assert.equal(leads[0]!.etapa, "revision");
});

test("un pago tardío de un cobro sustituido no marca pagado", () => {
  const conQR: Lead = {
    ...lead,
    cobro: { ...lead.cobro!, medio: "qr", id: "IDC-NUEVO", referencia: "2222222" },
    cobrosAnteriores: [{ ...lead.cobro!, estado: "sustituido" }],
  };
  const r = conciliar([conQR], pago, 1); // llega el webhook del push viejo (01TX, ref 1234567)
  assert.equal(r.resultado.tipo, "no_coincide");
  assert.equal(r.leads[0]!.etapa, "revision");
});

test("al conciliar guarda el folio y la CLABE ya enmascarada", () => {
  const l: Lead = { ...lead, cobro: { ...lead.cobro!, folioCodi: "12345678901234567890" } };
  const p = conciliar([l], { ...pago, clabeOrdenante: "•••• •••• •••• ••0000" }, 1).leads[0]!.pago!;
  assert.equal(p.folioCodi, "12345678901234567890");
  assert.equal(p.clabeOrdenante, "•••• •••• •••• ••0000");
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

test("tampoco reutiliza la referencia de un cobro vencido", () => {
  let n = 0;
  const azar = () => [0.0, 0.5][n++ % 2]!;
  const vencido: Lead = { ...lead, cobro: undefined, cobrosAnteriores: [{ ...lead.cobro!, referencia: "1000000", estado: "vencido_o_rechazado" }] };
  assert.notEqual(nuevaReferencia([vencido], azar), "1000000");
});
