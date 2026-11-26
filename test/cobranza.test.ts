import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarioDelMes,
  instanteCdmx,
  mensajePaso,
  montoDelPaso,
  pasosPendientes,
  proximaAlarma,
  validarPlan,
  type PlanColegiatura,
} from "../src/cobranza.ts";

const plan: PlanColegiatura = {
  familiaId: "fam-demo",
  alumno: "Sofía",
  celular: "5500000000",
  montoMXN: 4850,
  diaDePago: 5,
  descuentoProntoPagoMXN: 150,
  codiActivo: true,
};

test("las 9:00 de CDMX son las 15:00 UTC", () => {
  assert.equal(new Date(instanteCdmx(2027, 1, 5, 9) * 1000).toISOString(), "2027-01-05T15:00:00.000Z");
});

test("con CoDi activo: 7 pasos, 4 cobran, en orden", () => {
  const c = calendarioDelMes(plan, 2027, 1);
  assert.deepEqual(
    c.map((p) => p.tipo),
    ["aviso_previo", "aviso_vispera", "cobro_dia", "reintento_tarde", "reintento_siguiente", "ultimo_aviso", "escalar_colegio"],
  );
  assert.equal(c.filter((p) => p.cobra).length, 4);
  assert.ok(c.every((p, i) => i === 0 || p.en > c[i - 1]!.en));
});

test("sin CoDi activo entra primero el agente de adopción", () => {
  const c = calendarioDelMes({ ...plan, codiActivo: false }, 2027, 1);
  assert.equal(c[0]!.tipo, "adopcion");
  assert.equal(new Date(c[0]!.en * 1000).toISOString(), "2026-12-31T16:00:00.000Z"); // cruza de mes y año
});

test("el día de pago a las 9:00 toca el push + WhatsApp", () => {
  const ahora = instanteCdmx(2027, 1, 5, 9) + 60;
  const p = pasosPendientes(plan, 2027, 1, { pagado: false, hechos: ["aviso_previo", "aviso_vispera"] }, ahora);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.tipo, "cobro_dia");
  assert.deepEqual(p[0]!.medios, ["push", "whatsapp"]);
});

test("si ya pagó no hace nada ni programa alarma", () => {
  const ahora = instanteCdmx(2027, 1, 6, 9);
  assert.deepEqual(pasosPendientes(plan, 2027, 1, { pagado: true, hechos: ["cobro_dia"] }, ahora), []);
  assert.equal(proximaAlarma(plan, 2027, 1, { pagado: true, hechos: [] }, ahora), undefined);
});

test("alarma atrasada: solo ejecuta el paso más reciente (nunca dos pushes juntos)", () => {
  const ahora = instanteCdmx(2027, 1, 6, 10);
  const p = pasosPendientes(plan, 2027, 1, { pagado: false, hechos: [] }, ahora);
  assert.deepEqual(p.map((x) => x.tipo), ["reintento_siguiente"]);
});

test("próxima alarma = el siguiente paso no hecho", () => {
  const ahora = instanteCdmx(2027, 1, 5, 9) + 60;
  assert.equal(proximaAlarma(plan, 2027, 1, { pagado: false, hechos: ["cobro_dia"] }, ahora), instanteCdmx(2027, 1, 5, 18));
});

test("descuento por pronto pago solo el día de pago", () => {
  assert.equal(montoDelPaso(plan, "cobro_dia"), 4700);
  assert.equal(montoDelPaso(plan, "reintento_tarde"), 4700);
  assert.equal(montoDelPaso(plan, "reintento_siguiente"), 4850);
});

test("mensajes: dicen monto, alumno y nunca el celular", () => {
  const m = mensajePaso(plan, "aviso_previo", 1);
  assert.match(m, /Sofía/);
  assert.match(m, /enero/);
  assert.match(m, /4,850\.00/);
  assert.ok(!m.includes(plan.celular));
  assert.match(mensajePaso(plan, "escalar_colegio", 1), /colegio hable/);
});

test("valida el plan", () => {
  assert.throws(() => validarPlan({ ...plan, diaDePago: 31 }));
  assert.throws(() => validarPlan({ ...plan, montoMXN: 0 }));
  assert.throws(() => validarPlan({ ...plan, descuentoProntoPagoMXN: 5000 }));
});
