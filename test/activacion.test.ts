import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANCOS_CODI,
  identificarBanco,
  mensajeTrasPrueba,
  normalizar,
  PREGUNTA_BANCO,
  responderBanco,
} from "../src/activacion.ts";

test("normalizar quita acentos, mayúsculas y signos", () => {
  assert.equal(normalizar("  BanBajío!! "), "banbajio");
  assert.equal(normalizar("Ve por Más"), "ve por mas");
});

test("identifica el banco por sus apodos, dentro de una frase", () => {
  assert.equal(identificarBanco("tengo Bancomer")?.nombre, "BBVA");
  assert.equal(identificarBanco("uso citibanamex y nu")?.nombre, "Banamex");
  assert.equal(identificarBanco("banco azteca")?.nombre, "Banco Azteca");
  assert.equal(identificarBanco("Hey banco")?.nombre, "Hey Banco");
});

test("no confunde palabras que contienen el apodo", () => {
  assert.equal(identificarBanco("chevrolet heyday"), undefined);
  assert.equal(identificarBanco("santanderino"), undefined);
});

test("banco con CoDi: pasos, guía oficial y cobro de prueba", () => {
  const r = responderBanco("BBVA");
  assert.equal(r.paso, "activar");
  assert.equal(r.cobroPruebaMXN, 1);
  assert.match(r.mensaje, /BBVA sí tiene CoDi/);
  assert.match(r.mensaje, /mismo con el que me escribes/);
  assert.match(r.mensaje, /bbva\.mx/);
  assert.match(r.mensaje, /\$1/);
});

test("con la cuenta de pruebas de pey el cobro es de un centavo", () => {
  const r = responderBanco("santander", 0.01);
  assert.equal(r.cobroPruebaMXN, 0.01);
  assert.match(r.mensaje, /\$0\.01/);
});

test("banco fuera de la lista oficial: no inventa, ofrece alternativa", () => {
  const r = responderBanco("Nu");
  assert.equal(r.paso, "alternativa");
  assert.equal(r.cobroPruebaMXN, undefined);
  assert.match(r.mensaje, /lista oficial/);
  assert.match(r.mensaje, /liga de pago/);
});

test("bancos que Banxico marca sin CoDi hoy o solo para cobrar no reciben cobro de prueba", () => {
  for (const nombre of ["Intercam", "multiva", "Invex"]) {
    const r = responderBanco(nombre);
    assert.equal(r.paso, "alternativa", nombre);
    assert.equal(r.cobroPruebaMXN, undefined, nombre);
  }
});

test("sin respuesta se vuelve a preguntar el banco", () => {
  assert.deepEqual(responderBanco("  "), { paso: "preguntar_banco", mensaje: PREGUNTA_BANCO });
});

test("toda la lista trae liga https o la página oficial y alias normalizados", () => {
  for (const banco of BANCOS_CODI) {
    assert.match(banco.ayuda, /^https?:\/\//, banco.nombre);
    for (const a of banco.alias) assert.equal(normalizar(a), a, `${banco.nombre}: ${a}`);
  }
});

test("mensaje tras la prueba", () => {
  assert.match(mensajeTrasPrueba("pagado"), /tu CoDi funciona/);
  assert.match(mensajeTrasPrueba("vencido"), /vuelvo a mandar/);
});
