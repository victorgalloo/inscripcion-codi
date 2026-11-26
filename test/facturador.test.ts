import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ESPERAS_MS,
  armarSolicitudFactura,
  decidirFacturacion,
  facturarLead,
  finDelMesCdmx,
  nivelDeGrado,
  pagoDeLead,
  repoMemoria,
  sustituirConDatosFiscales,
  aplicarEventoFactura,
  type ContextoFacturador,
} from "../src/facturador.ts";
import { FacturacionMock } from "../src/facturacion/mock.ts";
import { ErrorFacturacion } from "../src/facturacion/http.ts";
import { EMISOR_DEMO, type ConfigFacturador } from "../src/facturacion/fabrica.ts";
import type { Facturacion, SolicitudCancelacion, SolicitudFactura } from "../src/facturacion/tipos.ts";
import { conciliar, type Lead } from "../src/conciliacion.ts";
import { instanteCdmx } from "../src/cobranza.ts";

const ESCUELA = "demo-abcdefgh";
const PAGADO = instanteCdmx(2026, 11, 26, 10);
const CONFIG: ConfigFacturador = { emisor: EMISOR_DEMO, claves: {} };
// Datos fiscales FICTICIOS (forma válida, no corresponden a nadie).
const FISCALES = { rfc: "GOMA800101AB1", nombre: "ANA GOMEZ DEMO", codigoPostal: "03100", regimenFiscal: "605", usoCfdi: "D10" };

function leadPagado(extra: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    familia: "Familia Demo (tú)",
    grado: "1° primaria",
    canal: "WhatsApp",
    etapa: "pagado",
    cobro: {
      medio: "push",
      proveedor: "mock",
      id: "01TX",
      montoMXN: 4850,
      concepto: "Inscripcion 2027-28 1o primaria",
      referencia: "1234567",
      expiraEn: PAGADO,
      creadoEn: 0,
    },
    pago: { medio: "push", transaccionId: "01TX", montoMXN: 4850, comisionMXN: 0, pagadoEn: PAGADO, conciliadoEn: 0 },
    ...extra,
  };
}

/** Facturación falsa: falla las primeras `fallas` veces con el error dado; luego timbra con el mock. */
function facturacionQueFalla(fallas: number, error: () => Error = () => new ErrorFacturacion(503, "Proveedor de facturación HTTP 503")) {
  const mock = new FacturacionMock({ ahora: () => PAGADO + 60 });
  const emitidas: SolicitudFactura[] = [];
  const canceladas: { id: string; c: SolicitudCancelacion }[] = [];
  let n = 0;
  const f: Facturacion = {
    proveedor: "mock",
    async emitir(s) {
      emitidas.push(s);
      if (n++ < fallas) throw error();
      return mock.emitir(s);
    },
    consultar: (id) => mock.consultar(id),
    async cancelar(id, c) {
      canceladas.push({ id, c });
      return mock.cancelar(id, c);
    },
    archivo: (fa, formato) => mock.archivo(fa, formato),
  };
  return { f, emitidas, canceladas };
}

function contexto(leads: Lead[], facturacion: Facturacion, extra: Partial<ContextoFacturador> = {}) {
  const repo = repoMemoria(leads);
  const esperas: number[] = [];
  const ctx: ContextoFacturador = {
    repo,
    facturacion,
    config: CONFIG,
    escuelaId: ESCUELA,
    esperar: async (ms) => {
      esperas.push(ms);
    },
    ...extra,
  };
  return { ctx, repo, esperas };
}

test("nivel educativo desde el grado", () => {
  assert.equal(nivelDeGrado("Kínder 2"), "Preescolar");
  assert.equal(nivelDeGrado("1° primaria"), "Primaria");
  assert.equal(nivelDeGrado("1° secundaria"), "Secundaria");
  assert.equal(nivelDeGrado("Taller de robótica"), undefined);
});

test("sin datos fiscales: público en general (XAXX010101000, S01, 616, CP del emisor) e InformacionGlobal", () => {
  const s = armarSolicitudFactura(pagoDeLead(leadPagado(), ESCUELA)!, CONFIG);
  assert.equal(s.publicoEnGeneral, true);
  assert.deepEqual(s.receptor, {
    rfc: "XAXX010101000",
    nombre: "PUBLICO EN GENERAL",
    codigoPostal: EMISOR_DEMO.codigoPostal,
    regimenFiscal: "616",
    usoCfdi: "S01",
  });
  assert.deepEqual(s.informacionGlobal, { periodicidad: "01", meses: "11", anio: 2026 });
  assert.equal(s.lugarExpedicion, EMISOR_DEMO.codigoPostal);
});

test("CFDI de ingreso: forma 03, PUE, MXN, IVA exento y total = subtotal", () => {
  const s = armarSolicitudFactura(pagoDeLead(leadPagado(), ESCUELA)!, CONFIG);
  assert.equal(s.tipoComprobante, "I");
  assert.equal(s.formaPago, "03");
  assert.equal(s.metodoPago, "PUE");
  assert.equal(s.moneda, "MXN");
  assert.equal(s.exportacion, "01");
  const [c] = s.conceptos;
  assert.equal(c!.claveUnidad, "E48");
  assert.equal(c!.objetoImp, "02");
  assert.deepEqual(c!.traslado, { impuesto: "002", tipoFactor: "Exento", base: 4850 });
  assert.equal(s.subtotal, 4850);
  assert.equal(s.total, 4850);
  assert.equal(s.llave, "01TX");
  assert.deepEqual(s.metadatos, { escuelaId: ESCUELA, leadId: "lead-1", pago: "01TX" });
});

test("totales en centavos: no arrastra decimales de punto flotante", () => {
  const s = armarSolicitudFactura({ ...pagoDeLead(leadPagado(), ESCUELA)!, montoMXN: 0.1 + 0.2 }, CONFIG);
  assert.equal(s.total, 0.3);
});

test("clave de producto: la configurada por nivel; si no hay, 01010101 (sin configurar)", () => {
  const p = pagoDeLead(leadPagado(), ESCUELA)!;
  assert.equal(armarSolicitudFactura(p, CONFIG).conceptos[0]!.claveProdServ, "01010101");
  const conClaves = { ...CONFIG, claves: { Primaria: "12345678" } };
  assert.equal(armarSolicitudFactura(p, conClaves).conceptos[0]!.claveProdServ, "12345678");
});

test("con datos fiscales: a nombre de la familia, sin InformacionGlobal; RFC inválido se rechaza", () => {
  const p = pagoDeLead(leadPagado(), ESCUELA)!;
  const s = armarSolicitudFactura(p, CONFIG, { datosFiscales: FISCALES });
  assert.equal(s.publicoEnGeneral, false);
  assert.equal(s.receptor.rfc, "GOMA800101AB1");
  assert.equal(s.informacionGlobal, undefined);
  assert.throws(() => armarSolicitudFactura(p, CONFIG, { datosFiscales: { ...FISCALES, rfc: "XYZ" } }), /RFC/);
  assert.throws(() => armarSolicitudFactura(p, CONFIG, { datosFiscales: { ...FISCALES, rfc: "XAXX010101000" } }), /genérico/);
});

test("decisión: sin pago no factura; un pago = una factura", () => {
  assert.equal(decidirFacturacion(leadPagado({ etapa: "cobro_enviado", pago: undefined })), "no_pagado");
  assert.equal(decidirFacturacion(leadPagado()), "facturar");
  assert.equal(decidirFacturacion(leadPagado({ factura: { llave: "01TX", estado: "timbrando", intentos: 0 } })), "ya_facturada");
  assert.equal(decidirFacturacion(leadPagado({ factura: { llave: "01TX", estado: "error", intentos: 3 } })), "en_error");
});

test("timbra a público en general y arma el WhatsApp que ofrece la factura a su nombre dentro del mes", async () => {
  const { f, emitidas } = facturacionQueFalla(0);
  const { ctx, repo } = contexto([leadPagado()], f);
  const r = await facturarLead(ctx, "lead-1");
  assert.equal(r.tipo, "timbrada");
  assert.equal(emitidas.length, 1);
  const reg = repo.actuales()[0]!.factura!;
  assert.equal(reg.estado, "timbrada");
  assert.match(reg.factura!.uuid!, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(reg.datosFiscalesHasta, finDelMesCdmx(PAGADO + 60));
  assert.match(reg.mensajeFamilia!, /público en general/);
  assert.match(reg.mensajeFamilia!, /RFC, nombre o razón social/);
  assert.match(reg.mensajeFamilia!, /antes del 30\/11\/2026/);
  assert.match(reg.mensajeFamilia!, /4,850\.00/);
  assert.match(repo.bitacora[0]!.texto, /CFDI 4\.0 timbrada · público en general/);
});

test("idempotencia: el mismo pago dos veces (webhook repetido) timbra una sola vez", async () => {
  const { f, emitidas } = facturacionQueFalla(0);
  const { ctx } = contexto([leadPagado()], f);
  await facturarLead(ctx, "lead-1");
  const r2 = await facturarLead(ctx, "lead-1");
  assert.equal(r2.tipo, "ya_facturada");
  assert.equal(emitidas.length, 1);
});

test("reintentos con espera creciente; al tercer fallo avisa al colegio y el cobro sigue pagado", async () => {
  const { f, emitidas } = facturacionQueFalla(5);
  const { ctx, repo, esperas } = contexto([leadPagado()], f);
  const r = await facturarLead(ctx, "lead-1");
  assert.equal(r.tipo, "escalada");
  assert.equal(emitidas.length, 3);
  assert.deepEqual(esperas, [...ESPERAS_MS]);
  assert.ok(esperas[1]! > esperas[0]!);
  const lead = repo.actuales()[0]!;
  assert.equal(lead.etapa, "pagado"); // nunca se revierte el cobro
  assert.equal(lead.pago!.transaccionId, "01TX");
  assert.equal(lead.factura!.estado, "error");
  assert.equal(lead.factura!.intentos, 3);
  if (r.tipo === "escalada") assert.match(r.avisoColegio, /tras 3 intentos.*sigue conciliado/);
  // Reintento manual: vuelve a intentar y ahora sí timbra.
  const r2 = await facturarLead(ctx, "lead-1", { reintentar: true });
  assert.equal(r2.tipo, "timbrada");
});

test("se recupera si el proveedor responde al segundo intento", async () => {
  const { f, emitidas } = facturacionQueFalla(1);
  const { ctx, esperas } = contexto([leadPagado()], f);
  const r = await facturarLead(ctx, "lead-1");
  assert.equal(r.tipo, "timbrada");
  assert.equal(emitidas.length, 2);
  assert.deepEqual(esperas, [ESPERAS_MS[0]]);
});

test("un error no reintentable (4xx) escala de inmediato, sin reintentar", async () => {
  const { f, emitidas } = facturacionQueFalla(5, () => new ErrorFacturacion(422, "Proveedor de facturación HTTP 422: CP inválido"));
  const { ctx, esperas } = contexto([leadPagado()], f);
  const r = await facturarLead(ctx, "lead-1");
  assert.equal(r.tipo, "escalada");
  assert.equal(emitidas.length, 1);
  assert.deepEqual(esperas, []);
});

test("datos fiscales dentro del mes: timbra la nueva (relación 04) y cancela la anterior con motivo 01 y su folio", async () => {
  const { f, emitidas, canceladas } = facturacionQueFalla(0);
  const { ctx, repo } = contexto([leadPagado()], f, { ahora: () => PAGADO + 3600 });
  await facturarLead(ctx, "lead-1");
  const anterior = repo.actuales()[0]!.factura!.factura!;
  const r = await sustituirConDatosFiscales(ctx, "lead-1", FISCALES);
  assert.equal(r.tipo, "sustituida");
  const nueva = emitidas[1]!;
  assert.deepEqual(nueva.cfdiRelacionados, { tipoRelacion: "04", uuids: [anterior.uuid!] });
  assert.equal(nueva.receptor.rfc, "GOMA800101AB1");
  assert.notEqual(nueva.llave, emitidas[0]!.llave);
  const reg = repo.actuales()[0]!.factura!;
  assert.deepEqual(canceladas, [{ id: anterior.id, c: { motivo: "01", folioSustitucion: reg.factura!.uuid } }]);
  assert.equal(reg.anteriores![0]!.estado, "cancelada");
  assert.equal(reg.factura!.publicoEnGeneral, false);
  assert.match(reg.mensajeFamilia!, /a nombre de ANA GOMEZ DEMO/);
});

test("datos fiscales fuera del mes: ya no se sustituye", async () => {
  const { f } = facturacionQueFalla(0);
  const { ctx } = contexto([leadPagado()], f, { ahora: () => instanteCdmx(2026, 12, 2, 10) });
  await facturarLead(ctx, "lead-1");
  const r = await sustituirConDatosFiscales(ctx, "lead-1", FISCALES);
  assert.equal(r.tipo, "fuera_de_plazo");
});

test("factura pendiente: el webhook «timbrada» la completa y entonces sale el WhatsApp", async () => {
  const mock = new FacturacionMock({ ahora: () => PAGADO });
  const pendiente: Facturacion = {
    ...mock,
    proveedor: "mock",
    emitir: async (s) => ({ ...(await mock.emitir(s)), estado: "pendiente", uuid: undefined }),
    consultar: (id) => mock.consultar(id),
    cancelar: (id, c) => mock.cancelar(id, c),
    archivo: (fa, fo) => mock.archivo(fa, fo),
  };
  const { ctx, repo } = contexto([leadPagado()], pendiente);
  const r = await facturarLead(ctx, "lead-1");
  assert.equal(r.tipo, "pendiente");
  assert.equal(repo.actuales()[0]!.factura!.mensajeFamilia, undefined);
  const f = repo.actuales()[0]!.factura!.factura!;
  const e = await aplicarEventoFactura(repo, {
    tipo: "factura.timbrada",
    factura: { ...f, estado: "timbrada", uuid: "6F1C2B3A-0D4E-4F5A-8B6C-7D8E9F0A1B2C" },
  });
  assert.equal(e.tipo, "actualizada");
  const reg = repo.actuales()[0]!.factura!;
  assert.equal(reg.estado, "timbrada");
  assert.match(reg.mensajeFamilia!, /6F1C2B3A/);
});

test("cadena completa: conciliar marca pagado → el facturador emite con la transacción como llave", async () => {
  const sinPagar = leadPagado({ etapa: "cobro_enviado", pago: undefined });
  const { leads, resultado } = conciliar(
    [sinPagar],
    {
      medio: "push",
      transaccionId: "01TX",
      montoMXN: 4850,
      referencia: "1234567",
      concepto: "Inscripcion 2027-28 1o primaria",
      pagadoEn: PAGADO,
      metadatos: { escuelaId: ESCUELA, leadId: "lead-1" },
    },
    0,
  );
  assert.equal(resultado.tipo, "conciliado");
  const { f, emitidas } = facturacionQueFalla(0);
  const { ctx } = contexto(leads, f);
  assert.equal((await facturarLead(ctx, "lead-1")).tipo, "timbrada");
  assert.equal(emitidas[0]!.llave, "01TX");
  assert.equal(emitidas[0]!.conceptos[0]!.descripcion, "Inscripcion 2027-28 1o primaria");
});
