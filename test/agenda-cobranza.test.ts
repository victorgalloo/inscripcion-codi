import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activarCodi,
  avanzar,
  ejecutar,
  marcarPagada,
  nuevaColegiatura,
  publica,
  resumen,
  siguientePaso,
  type EjecutorCobranza,
} from "../src/agenda-cobranza.ts";
import { instanteCdmx, type PlanColegiatura } from "../src/cobranza.ts";

const plan: PlanColegiatura = {
  familiaId: "fam-navarro",
  alumno: "Sofía",
  celular: "5500000042",
  montoMXN: 4850,
  diaDePago: 5,
  descuentoProntoPagoMXN: 150,
  codiActivo: true,
};

function ejecutorFalso() {
  const llamadas: { tipo: string; monto: number }[] = [];
  let n = 1000000;
  const e: EjecutorCobranza = {
    async cobrar(_c, paso, montoMXN) {
      llamadas.push({ tipo: paso.tipo, monto: montoMXN });
      return { referencia: String(n++) };
    },
  };
  return { e, llamadas };
}

test("arranca antes del primer aviso y el id lleva familia y mes", () => {
  const c = nuevaColegiatura(plan, 2027, 1);
  assert.equal(c.id, "fam-navarro-2027-01");
  assert.equal(siguientePaso(c)?.tipo, "aviso_previo");
  assert.ok(c.reloj < instanteCdmx(2027, 1, 2, 10));
});

test("sin CoDi el primer paso es el agente de adopción; al activarlo se salta", () => {
  const c = nuevaColegiatura({ ...plan, codiActivo: false }, 2027, 1);
  assert.equal(siguientePaso(c)?.tipo, "adopcion");
  assert.equal(siguientePaso(activarCodi(c))?.tipo, "aviso_previo");
});

test("los avisos no cobran; el día de pago manda push CoDi con el descuento", async () => {
  const { e, llamadas } = ejecutorFalso();
  let c = nuevaColegiatura(plan, 2027, 1);
  for (let i = 0; i < 3; i++) c = (await avanzar(c, e)).colegiatura;
  assert.deepEqual(c.hechos, ["aviso_previo", "aviso_vispera", "cobro_dia"]);
  assert.deepEqual(llamadas, [{ tipo: "cobro_dia", monto: 4700 }]);
  assert.equal(c.cobros.length, 1);
  assert.match(c.mensajes.at(-1)!.texto, /Aceptar/);
});

test("si paga el cobro del día, se detiene: no hay más pasos ni cobros", async () => {
  const { e, llamadas } = ejecutorFalso();
  let c = nuevaColegiatura(plan, 2027, 1);
  for (let i = 0; i < 3; i++) c = (await avanzar(c, e)).colegiatura;
  const r = marcarPagada(c, c.cobros[0]!.referencia, 4700, instanteCdmx(2027, 1, 5, 9) + 80);
  assert.equal(r.tipo, "conciliado");
  if (r.tipo !== "conciliado") return;
  assert.equal(r.colegiatura.pagadaCon, "cobro_dia");
  assert.equal(siguientePaso(r.colegiatura), undefined);
  const otra = await avanzar(r.colegiatura, e);
  assert.equal(otra.paso, undefined);
  assert.equal(llamadas.length, 1);
  assert.equal(marcarPagada(r.colegiatura, c.cobros[0]!.referencia, 4700, 0).tipo, "duplicado");
});

test("el pago no se concilia con otra referencia ni con otro monto", async () => {
  const { e } = ejecutorFalso();
  let c = nuevaColegiatura(plan, 2027, 1);
  for (let i = 0; i < 3; i++) c = (await avanzar(c, e)).colegiatura;
  assert.equal(marcarPagada(c, "9999999", 4700, 0).tipo, "no_coincide");
  assert.equal(marcarPagada(c, c.cobros[0]!.referencia, 4850, 0).tipo, "no_coincide");
});

test("sin pago: 4 cobros CoDi nuevos y al final pasa al colegio", async () => {
  const { e, llamadas } = ejecutorFalso();
  let c = nuevaColegiatura(plan, 2027, 1);
  while (siguientePaso(c)) c = (await avanzar(c, e)).colegiatura;
  assert.deepEqual(llamadas.map((l) => l.tipo), ["cobro_dia", "reintento_tarde", "reintento_siguiente", "ultimo_aviso"]);
  assert.equal(new Set(c.cobros.map((x) => x.referencia)).size, 4);
  assert.equal(c.hechos.at(-1), "escalar_colegio");
  assert.equal(resumen([c]).paraElColegio, 1);
});

test("alarma atrasada: ejecuta solo el paso más reciente y no repite los saltados", async () => {
  const { e, llamadas } = ejecutorFalso();
  const c = nuevaColegiatura(plan, 2027, 1);
  const r = await ejecutar(c, instanteCdmx(2027, 1, 6, 10), e);
  assert.equal(r.paso?.tipo, "reintento_siguiente");
  assert.equal(llamadas.length, 1);
  assert.equal(siguientePaso(r.colegiatura)?.tipo, "ultimo_aviso");
});

test("resumen: familias con CoDi, pagadas a la primera y monto cobrado", async () => {
  const { e } = ejecutorFalso();
  let a = nuevaColegiatura(plan, 2027, 1);
  for (let i = 0; i < 3; i++) a = (await avanzar(a, e)).colegiatura;
  const r = marcarPagada(a, a.cobros[0]!.referencia, 4700, 1);
  assert.equal(r.tipo, "conciliado");
  const b = nuevaColegiatura({ ...plan, familiaId: "fam-ibarra", codiActivo: false }, 2027, 1);
  const s = resumen([r.tipo === "conciliado" ? r.colegiatura : a, b]);
  assert.deepEqual(s, {
    familias: 2,
    conCodi: 1,
    pagadas: 1,
    pagadasALaPrimera: 1,
    cobrosCodi: 1,
    montoCobradoMXN: 4700,
    paraElColegio: 0,
  });
});

test("al navegador el celular va enmascarado", () => {
  assert.equal(publica(nuevaColegiatura(plan, 2027, 1)).plan.celular, "••••••42");
});

test("el aviso de la víspera dice el mismo monto que trae el push del día", async () => {
  const { e, llamadas } = ejecutorFalso();
  let c = nuevaColegiatura(plan, 2027, 1);
  for (let i = 0; i < 3; i++) c = (await avanzar(c, e)).colegiatura;
  assert.match(c.mensajes[1]!.texto, /\$4,700/);
  assert.equal(llamadas[0]!.monto, 4700);
});
