import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enmascararClabe,
  validarPoliticaCobro,
  validarSolicitud,
  type SolicitudCobro,
} from "../src/pagos/tipos.ts";
import { mensajeAntesDelCobro } from "../src/mensajes.ts";
import { CUOTA_INSCRIPCION, ESCUELA_DEMO, VIGENCIA_SEGUNDOS } from "../src/demo.ts";
import { interpretarEventoPey } from "../src/pagos/pey.ts";

const s: SolicitudCobro = {
  montoMXN: 4850,
  concepto: "Inscripcion 2027-28 1o primaria",
  referencia: "1234567",
  vigenciaSegundos: 1800,
  metadatos: {},
};
const ok = { montoConfirmadoMXN: 4850 };

test("concepto: de 1 a 40 caracteres", () => {
  validarSolicitud({ ...s, concepto: "x".repeat(40) });
  assert.throws(() => validarSolicitud({ ...s, concepto: "x".repeat(41) }), /40 caracteres/);
  assert.throws(() => validarSolicitud({ ...s, concepto: "  " }), /obligatorio/);
});

test("referencia numérica: solo dígitos, de 1 a 7", () => {
  validarSolicitud({ ...s, referencia: "1" });
  validarSolicitud({ ...s, referencia: "9999999" });
  for (const ref of ["", "12345678", "12a4567", "-123", "1 2"]) {
    assert.throws(() => validarSolicitud({ ...s, referencia: ref }), /referencia/, ref);
  }
});

test("vigencia: 30 a 60 min en la política (Pey acepta desde 360 s)", () => {
  validarSolicitud({ ...s, vigenciaSegundos: 360 });
  validarPoliticaCobro({ ...s, vigenciaSegundos: 1800 }, ok);
  validarPoliticaCobro({ ...s, vigenciaSegundos: 3600 }, ok);
  assert.throws(() => validarPoliticaCobro({ ...s, vigenciaSegundos: 360 }, ok), /30 a 60/);
  assert.throws(() => validarPoliticaCobro({ ...s, vigenciaSegundos: 3601 }, ok), /30 a 60/);
});

test("monto: igual al que confirmó la familia, sin recargo", () => {
  assert.throws(() => validarPoliticaCobro({ ...s, montoMXN: 4850 + 116 }, ok), /confirmó la familia/);
  assert.throws(() => validarPoliticaCobro(s, { montoConfirmadoMXN: Number.NaN }), /confirmó la familia/);
});

test("concepto sin datos personales (p. ej. el nombre del menor)", () => {
  const conNombre = { ...s, concepto: "Inscripcion Sofía Pérez 1o" };
  assert.throws(() => validarPoliticaCobro(conNombre, { ...ok, datosPrivados: ["Sofia Perez"] }), /datos personales/);
  validarPoliticaCobro(s, { ...ok, datosPrivados: ["Sofía Pérez"] });
});

test("la cuota de la demo cumple la política y queda debajo de 1,500 UDIS", () => {
  validarPoliticaCobro(
    { ...s, montoMXN: CUOTA_INSCRIPCION.montoMXN, concepto: CUOTA_INSCRIPCION.concepto, vigenciaSegundos: VIGENCIA_SEGUNDOS },
    { montoConfirmadoMXN: CUOTA_INSCRIPCION.montoMXN },
  );
  // 1,500 UDIS ≈ $13 mil (cálculo propio); usamos un tope conservador de $12,000.
  assert.ok(CUOTA_INSCRIPCION.montoMXN <= 12_000);
});

test("CLABE: solo los últimos 4 dígitos, nunca completa", () => {
  assert.equal(enmascararClabe("012180001234567897"), "•••• •••• •••• ••7897");
  assert.equal(enmascararClabe(undefined), undefined);
  const p = interpretarEventoPey({
    type: "codi.pn.payment_received", amount: 1, transactionId: "t", numRef: "1",
    metadata: { clabe: "012180001234567897" },
  });
  assert.equal(p.clabeOrdenante, "•••• •••• •••• ••7897");
  assert.ok(!JSON.stringify(p).includes("012180001234567897"));
});

test("mensaje antes del push: razón social exacta, monto, concepto, ref, vigencia, sin comisión", () => {
  const expiraEn = Date.UTC(2026, 10, 14, 21, 30) / 1000; // 15:30 en CDMX
  const m = mensajeAntesDelCobro(
    { medio: "push", montoMXN: 4850, concepto: s.concepto, referencia: "1234567", expiraEn, celular: "•• •••• ••42" },
    ESCUELA_DEMO.razonSocial,
  );
  assert.match(m, /Beneficiario: Colegio Aurora, S\.C\. \(demo\)/);
  assert.match(m, /\$4,850\.00, sin comisión/);
  assert.match(m, /Concepto: Inscripcion 2027-28 1o primaria/);
  assert.match(m, /Referencia: 1234567/);
  assert.match(m, /Vale hasta: 14\/11\/2026 15:30 \(hora del centro\)/);
  assert.match(m, /Rechazarla o Posponerla/);
  assert.match(m, /QR o una liga de pago/);
});
