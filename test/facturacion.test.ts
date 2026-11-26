import { test } from "node:test";
import assert from "node:assert/strict";
import { FacturacionMock, LEYENDA_SIMULADO } from "../src/facturacion/mock.ts";
import { ErrorFacturacion, FacturacionHttp } from "../src/facturacion/http.ts";
import { EMISOR_DEMO, configFacturador, crearFacturacion, secretoWebhookFacturacion } from "../src/facturacion/fabrica.ts";
import { datosFiscalesDe, interpretarEventoFactura, validarCancelacion, type Factura } from "../src/facturacion/tipos.ts";
import { armarSolicitudFactura } from "../src/facturador.ts";
import { crearAlmacenFacturasMemoria, ieduDe, rutasFacturas, webhookFacturacion } from "../src/facturas.ts";
import { firmarWebhook } from "../src/webhooks.ts";
import { construirLlmsTxt, construirOfertaAgente } from "../src/agente.ts";
import type { Lead } from "../src/conciliacion.ts";

const ESCUELA = "demo-abcdefgh";
const ORIGEN = "https://inscrito.ejemplo.invalid";
const CONFIG = { emisor: EMISOR_DEMO, claves: {} };
const FISCALES = { rfc: "GOMA800101AB1", nombre: "Ana Gomez Demo", codigoPostal: "03100", regimenFiscal: "605", usoCfdi: "d10" };
// Secreto de PRUEBA: "whsec_" + base64 de un texto fijo.
const SECRETO = "whsec_" + btoa("solo-para-tests-facturacion-0000");

const solicitud = () =>
  armarSolicitudFactura(
    {
      llave: "01TX",
      leadId: "lead-1",
      escuelaId: ESCUELA,
      montoMXN: 4850,
      descripcion: "Inscripcion 2027-28 1o primaria",
      nivel: "Primaria",
      pagadoEn: 1_800_000_000,
    },
    CONFIG,
  );

function fetchFalso(respuesta: unknown, status = 200) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    llamadas.push({ url, init });
    return new Response(typeof respuesta === "string" ? respuesta : JSON.stringify(respuesta), { status });
  };
  return { llamadas, fetcher };
}

const facturaCanonica = (extra: Partial<Factura> = {}): Factura => ({
  proveedor: "http",
  id: "fac_123",
  llave: "01TX",
  uuid: "6F1C2B3A-0D4E-4F5A-8B6C-7D8E9F0A1B2C",
  estado: "timbrada",
  emisor: { rfc: EMISOR_DEMO.rfc, nombre: EMISOR_DEMO.nombre },
  receptor: { rfc: "XAXX010101000", nombre: "PUBLICO EN GENERAL", usoCfdi: "S01" },
  publicoEnGeneral: true,
  conceptos: [{ claveProdServ: "01010101", descripcion: "Inscripcion 2027-28 1o primaria", importe: 4850 }],
  subtotal: 4850,
  total: 4850,
  moneda: "MXN",
  formaPago: "03",
  metodoPago: "PUE",
  emitidaEn: 1_800_000_100,
  metadatos: { escuelaId: ESCUELA, leadId: "lead-1" },
  ...extra,
});

// ───────── tipos ─────────

test("datos fiscales: normaliza mayúsculas y valida RFC, CP, régimen y uso", () => {
  const d = datosFiscalesDe(FISCALES);
  assert.equal(d.nombre, "ANA GOMEZ DEMO");
  assert.equal(d.usoCfdi, "D10");
  assert.throws(() => datosFiscalesDe({ ...FISCALES, codigoPostal: "123" }), /código postal/);
  assert.throws(() => datosFiscalesDe({ ...FISCALES, regimenFiscal: "x" }), /régimen/);
  assert.throws(() => datosFiscalesDe({ ...FISCALES, usoCfdi: "deducir" }), /uso del CFDI/);
});

test("cancelación: el motivo 01 exige el UUID sustituto; los demás no lo llevan", () => {
  assert.throws(() => validarCancelacion({ motivo: "01" }), /01 exige/);
  assert.doesNotThrow(() => validarCancelacion({ motivo: "01", folioSustitucion: facturaCanonica().uuid }));
  assert.doesNotThrow(() => validarCancelacion({ motivo: "02" }));
  assert.throws(() => validarCancelacion({ motivo: "03", folioSustitucion: facturaCanonica().uuid }));
  assert.throws(() => validarCancelacion({ motivo: "05" as "01" }));
});

test("IEDU opcional: valida CURP y nivel; sin datos → undefined", () => {
  assert.equal(ieduDe(undefined), undefined);
  const i = ieduDe({ nombreAlumno: "Alumno Demo", CURP: "XEXX010101HNEXXXA4", nivelEducativo: "Primaria", autRVOE: "RVOE-DEMO" });
  assert.equal(i?.version, "1.0");
  assert.throws(() => ieduDe({ nombreAlumno: "A", CURP: "X", nivelEducativo: "Primaria", autRVOE: "R" }), /CURP/);
});

// ───────── mock ─────────

test("mock: UUID con forma real, ligas internas, idempotente por llave y sin datos del alumno", async () => {
  const m = new FacturacionMock({ ahora: () => 1_800_000_100 });
  const s = solicitud();
  s.conceptos[0]!.iedu = { version: "1.0", nombreAlumno: "Alumno Demo", CURP: "XEXX010101HNEXXXA4", nivelEducativo: "Primaria", autRVOE: "R" };
  const f = await m.emitir(s);
  assert.match(f.uuid!, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.equal(f.estado, "timbrada");
  assert.equal(f.pdfUrl, `/api/facturas/${f.id}/pdf`);
  assert.equal(f.xmlUrl, `/api/facturas/${f.id}/xml`);
  assert.ok(!JSON.stringify(f).includes("Alumno Demo"));
  assert.deepEqual(await m.emitir(s), f);
});

test("mock: PDF y XML de muestra marcados SIMULADO, sin validez fiscal", async () => {
  const m = new FacturacionMock();
  const f = await m.emitir(solicitud());
  const pdf = await m.archivo(f, "pdf");
  const bytes = pdf.cuerpo as Uint8Array;
  const texto = String.fromCharCode(...bytes);
  assert.equal(pdf.tipo, "application/pdf");
  assert.ok(texto.startsWith("%PDF-1.4"));
  assert.ok(texto.trimEnd().endsWith("%%EOF"));
  assert.match(texto, /SIMULADO, SIN VALIDEZ FISCAL/);
  // El xref apunta a cada objeto.
  const xref = Number(/startxref\n(\d+)/.exec(texto)![1]);
  assert.ok(texto.slice(xref).startsWith("xref"));
  const xml = String((await m.archivo(f, "xml")).cuerpo);
  assert.match(xml, new RegExp(LEYENDA_SIMULADO));
  assert.match(xml, /TipoFactor="Exento"/);
  assert.match(xml, /FormaPago="03"/);
  assert.match(xml, /MetodoPago="PUE"/);
  assert.match(xml, new RegExp(f.uuid!));
});

// ───────── adaptador http ─────────

test("http: POST a la ruta por defecto con Bearer, Idempotency-Key y el contrato canónico", async () => {
  const { llamadas, fetcher } = fetchFalso(facturaCanonica());
  const h = new FacturacionHttp({ base: "https://facturas.ejemplo.invalid/v1/", apiKey: "llave-de-prueba", fetcher });
  const s = solicitud();
  const f = await h.emitir(s);
  assert.equal(llamadas[0]!.url, "https://facturas.ejemplo.invalid/v1/facturas");
  assert.equal(llamadas[0]!.init!.method, "POST");
  const cab = llamadas[0]!.init!.headers as Record<string, string>;
  assert.equal(cab.Authorization, "Bearer llave-de-prueba");
  assert.equal(cab["Idempotency-Key"], "01TX");
  assert.equal(cab["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(llamadas[0]!.init!.body)), JSON.parse(JSON.stringify(s)));
  assert.equal(f.proveedor, "http");
  assert.equal(f.uuid, facturaCanonica().uuid);
});

test("http: cabecera, prefijo y rutas sobreescribibles; llave desde la bóveda", async () => {
  const { llamadas, fetcher } = fetchFalso(facturaCanonica({ estado: "cancelada" }));
  const h = new FacturacionHttp({
    base: "https://facturas.ejemplo.invalid",
    apiKey: async () => "llave-boveda",
    cabecera: "X-Api-Key",
    prefijo: "",
    rutas: { cancelar: "/cfdi/{id}/baja", consultar: "/cfdi/{id}" },
    fetcher,
  });
  await h.cancelar("fac 1", { motivo: "02" });
  await h.consultar("fac_1");
  assert.equal(llamadas[0]!.url, "https://facturas.ejemplo.invalid/cfdi/fac%201/baja");
  assert.equal((llamadas[0]!.init!.headers as Record<string, string>)["X-Api-Key"], "llave-boveda");
  assert.deepEqual(JSON.parse(String(llamadas[0]!.init!.body)), { motivo: "02" });
  assert.equal(llamadas[1]!.url, "https://facturas.ejemplo.invalid/cfdi/fac_1");
  assert.equal(llamadas[1]!.init!.method, "GET");
});

test("http: 4xx no reintentable, 5xx/429/red sí; respuesta fuera de contrato → error", async () => {
  const err = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as ErrorFacturacion;
    }
    assert.fail("debía fallar");
  };
  const e422 = await err(
    new FacturacionHttp({ base: "https://x.invalid", apiKey: "k", fetcher: fetchFalso({ error: "RFC no existe" }, 422).fetcher }).emitir(solicitud()),
  );
  assert.equal(e422.status, 422);
  assert.equal(e422.reintentable, false);
  assert.match(e422.message, /RFC no existe/);
  const e503 = await err(new FacturacionHttp({ base: "https://x.invalid", apiKey: "k", fetcher: fetchFalso({}, 503).fetcher }).emitir(solicitud()));
  assert.equal(e503.reintentable, true);
  const e429 = await err(new FacturacionHttp({ base: "https://x.invalid", apiKey: "k", fetcher: fetchFalso({}, 429).fetcher }).emitir(solicitud()));
  assert.equal(e429.reintentable, true);
  const red = await err(
    new FacturacionHttp({
      base: "https://x.invalid",
      apiKey: "k",
      fetcher: async () => {
        throw new TypeError("fetch failed");
      },
    }).emitir(solicitud()),
  );
  assert.equal(red.status, 0);
  assert.equal(red.reintentable, true);
  const raro = await err(new FacturacionHttp({ base: "https://x.invalid", apiKey: "k", fetcher: fetchFalso({ ok: 1 }).fetcher }).emitir(solicitud()));
  assert.match(raro.message, /fuera del contrato/);
  const sinLlave = await err(new FacturacionHttp({ base: "https://x.invalid", apiKey: "", fetcher: fetchFalso({}).fetcher }).emitir(solicitud()));
  assert.match(sinLlave.message, /FACTURACION_API_KEY/);
});

test("http: descarga PDF/XML por la ruta de archivo", async () => {
  const { llamadas, fetcher } = fetchFalso("%PDF-1.4 ...");
  const h = new FacturacionHttp({ base: "https://x.invalid", apiKey: "k", fetcher });
  const a = await h.archivo(facturaCanonica(), "pdf");
  assert.equal(llamadas[0]!.url, "https://x.invalid/facturas/fac_123/pdf");
  assert.equal(new TextDecoder().decode(a.cuerpo as Uint8Array), "%PDF-1.4 ...");
});

test("fábrica: mock por defecto; http exige URL; claves por nivel desde JSON", async () => {
  assert.equal(crearFacturacion({}).proveedor, "mock");
  assert.equal(crearFacturacion({ FACTURACION_PROVEEDOR: "mock" }).proveedor, "mock");
  assert.throws(() => crearFacturacion({ FACTURACION_PROVEEDOR: "http" }), /FACTURACION_URL/);
  const { llamadas, fetcher } = fetchFalso(facturaCanonica());
  const h = crearFacturacion(
    {
      FACTURACION_PROVEEDOR: "http",
      FACTURACION_URL: "https://facturas.ejemplo.invalid",
      FACTURACION_API_KEY: { get: async () => "desde-boveda" },
      FACTURACION_RUTA_EMITIR: "/cfdi",
    },
    { fetcher },
  );
  await h.emitir(solicitud());
  assert.equal(llamadas[0]!.url, "https://facturas.ejemplo.invalid/cfdi");
  assert.equal((llamadas[0]!.init!.headers as Record<string, string>).Authorization, "Bearer desde-boveda");
  const c = configFacturador({ FACTURACION_CLAVES_PRODSERV: '{"Primaria":"12345678","Secundaria":"malo"}' });
  assert.deepEqual(c.claves, { Primaria: "12345678" });
  assert.deepEqual(c.emisor, EMISOR_DEMO);
  assert.equal(await secretoWebhookFacturacion({ FACTURACION_WEBHOOK_SECRET: { get: async () => "s" } }), "s");
});

// ───────── rutas ─────────

const leadPagado = (): Lead => ({
  id: "lead-1",
  familia: "Familia Demo (tú)",
  grado: "1° primaria",
  canal: "WhatsApp",
  etapa: "pagado",
  cobro: { medio: "push", proveedor: "mock", id: "01TX", montoMXN: 4850, concepto: "Inscripcion 2027-28 1o primaria", referencia: "1234567", expiraEn: 0, creadoEn: 0 },
  pago: { medio: "push", transaccionId: "01TX", montoMXN: 4850, comisionMXN: 0, pagadoEn: Math.floor(Date.now() / 1000), conciliadoEn: 0 },
});

function rutas() {
  const facturacion = new FacturacionMock();
  const almacen = crearAlmacenFacturasMemoria([leadPagado()], facturacion, CONFIG, ESCUELA, { esperar: async () => {} });
  const llamar = async (metodo: string, ruta: string, body: Record<string, unknown> = {}) => {
    const res = await rutasFacturas({ metodo, ruta, body, escuela: ESCUELA, origen: ORIGEN, almacen, facturacion });
    assert.ok(res, `sin ruta ${ruta}`);
    return res;
  };
  return { almacen, llamar };
}

test("rutas: POST /api/facturas emite (201) y repetirlo no timbra otra (200 ya_facturada)", async () => {
  const { llamar } = rutas();
  const r1 = await llamar("POST", "/api/facturas", { leadId: "lead-1" });
  assert.equal(r1.status, 201);
  const j1 = (await r1.json()) as { resultado: { tipo: string; registro: { factura: Factura } }; ligas: { pdf: string } };
  assert.equal(j1.resultado.tipo, "timbrada");
  const id = j1.resultado.registro.factura.id;
  assert.equal(j1.ligas.pdf, `${ORIGEN}/api/facturas/${id}/pdf?escuela=${ESCUELA}`);
  const r2 = await llamar("POST", "/api/facturas", { leadId: "lead-1" });
  assert.equal(r2.status, 200);
  assert.equal(((await r2.json()) as { resultado: { tipo: string } }).resultado.tipo, "ya_facturada");
  assert.equal((await llamar("POST", "/api/facturas", {})).status, 400);
  assert.equal((await llamar("POST", "/api/facturas", { leadId: "otro" })).status, 409);
});

test("rutas: GET factura, PDF y XML; 404 si no existe", async () => {
  const { llamar } = rutas();
  const j = (await (await llamar("POST", "/api/facturas", { leadId: "lead-1" })).json()) as { resultado: { registro: { factura: Factura } } };
  const id = j.resultado.registro.factura.id;
  const g = await llamar("GET", `/api/facturas/${id}`);
  assert.equal(g.status, 200);
  assert.equal(((await g.json()) as { leadId: string }).leadId, "lead-1");
  const pdf = await llamar("GET", `/api/facturas/${id}/pdf`);
  assert.equal(pdf.headers.get("Content-Type"), "application/pdf");
  assert.ok((await pdf.text()).startsWith("%PDF"));
  const xml = await llamar("GET", `/api/facturas/${id}/xml`);
  assert.match(await xml.text(), /SIMULADO/);
  assert.equal((await llamar("GET", "/api/facturas/fac_nada")).status, 404);
  assert.equal(await rutasFacturas({ metodo: "GET", ruta: "/api/tablero", body: {}, escuela: ESCUELA, origen: ORIGEN, almacen: rutas().almacen, facturacion: new FacturacionMock() }), undefined);
});

test("rutas: datos-fiscales sustituye; cancelar valida el motivo", async () => {
  const { llamar } = rutas();
  const j = (await (await llamar("POST", "/api/facturas", { leadId: "lead-1" })).json()) as { resultado: { registro: { factura: Factura } } };
  const anterior = j.resultado.registro.factura;
  assert.equal((await llamar("POST", "/api/facturas/datos-fiscales", { leadId: "lead-1", ...FISCALES, rfc: "MAL" })).status, 422);
  const s = await llamar("POST", "/api/facturas/datos-fiscales", { leadId: "lead-1", ...FISCALES });
  assert.equal(s.status, 201);
  const js = (await s.json()) as { resultado: { tipo: string; registro: { factura: Factura; anteriores: Factura[] } } };
  assert.equal(js.resultado.tipo, "sustituida");
  assert.equal(js.resultado.registro.anteriores[0]!.id, anterior.id);
  assert.equal(js.resultado.registro.anteriores[0]!.estado, "cancelada");
  const nueva = js.resultado.registro.factura;
  assert.equal((await llamar("POST", `/api/facturas/${nueva.id}/cancelar`, { motivo: "01" })).status, 422);
  const c = await llamar("POST", `/api/facturas/${nueva.id}/cancelar`, { motivo: "03" });
  assert.equal(c.status, 200);
  assert.equal(((await c.json()) as { factura: Factura }).factura.estado, "cancelada");
  assert.equal((await llamar("GET", `/api/facturas/${nueva.id}/cancelar`)).status, 405);
});

// ───────── webhook ─────────

async function peticionWebhook(cuerpo: string, secreto = SECRETO, ts = Math.floor(Date.now() / 1000)) {
  return new Request(`${ORIGEN}/webhooks/facturacion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": "msg_fac_1",
      "webhook-timestamp": String(ts),
      "webhook-signature": await firmarWebhook(secreto, "msg_fac_1", ts, cuerpo),
    },
    body: cuerpo,
  });
}

test("webhook de facturación: firma buena aplica el evento una vez; firma mala → 401", async () => {
  const { almacen, llamar } = rutas();
  const j = (await (await llamar("POST", "/api/facturas", { leadId: "lead-1" })).json()) as { resultado: { registro: { factura: Factura } } };
  const f = j.resultado.registro.factura;
  const cuerpo = JSON.stringify({ tipo: "factura.cancelada", factura: { ...f, estado: "cancelada", motivoCancelacion: "03" } });
  const opciones = { secreto: SECRETO, obtenerAlmacen: () => almacen, escuelaValida: (e: string) => e === ESCUELA };

  const mala = await webhookFacturacion(await peticionWebhook(cuerpo, "whsec_" + btoa("otro-secreto-cualquiera-0000000")), opciones);
  assert.equal(mala.status, 401);
  assert.equal(almacen.repo.actuales()[0]!.factura!.estado, "timbrada");

  const buena = await webhookFacturacion(await peticionWebhook(cuerpo), opciones);
  assert.equal(buena.status, 200);
  assert.equal(((await buena.json()) as { resultado: { tipo: string } }).resultado.tipo, "actualizada");
  assert.equal(almacen.repo.actuales()[0]!.factura!.estado, "cancelada");

  const repetido = await webhookFacturacion(await peticionWebhook(cuerpo), opciones);
  assert.equal(((await repetido.json()) as { resultado: { tipo: string } }).resultado.tipo, "duplicado");

  assert.equal((await webhookFacturacion(await peticionWebhook("{}"), opciones)).status, 400);
  assert.equal((await webhookFacturacion(await peticionWebhook(cuerpo), { ...opciones, secreto: undefined })).status, 500);
  const otraEscuela = JSON.stringify({ tipo: "factura.timbrada", factura: { ...f, metadatos: {} } });
  assert.equal((await webhookFacturacion(await peticionWebhook(otraEscuela), opciones)).status, 422);
});

test("evento canónico: rechaza tipos desconocidos o sin factura", () => {
  assert.throws(() => interpretarEventoFactura({ tipo: "otro" }), /no soportado/);
  assert.throws(() => interpretarEventoFactura({ tipo: "factura.timbrada" }), /no trae/);
  assert.equal(interpretarEventoFactura({ tipo: "factura.timbrada", factura: facturaCanonica() }).factura.id, "fac_123");
});

// ───────── para agentes ─────────

test("oferta.json y llms.txt anuncian la factura automática y el endpoint de datos fiscales", () => {
  const o = construirOfertaAgente({ PAGOS_PROVEEDOR: "mock" }, ORIGEN);
  assert.equal(o.facturacion.automatica, true);
  assert.equal(o.facturacion.cfdi, "4.0");
  assert.equal(o.endpoints.datos_fiscales, `${ORIGEN}/api/facturas/datos-fiscales`);
  assert.match(o.facturacion.sin_datos_fiscales, /XAXX010101000/);
  const txt = construirLlmsTxt({ PAGOS_PROVEEDOR: "mock" }, ORIGEN);
  assert.match(txt, /## Factura \(CFDI 4\.0\): llega sola/);
  assert.match(txt, /\/api\/facturas\/datos-fiscales/);
});
