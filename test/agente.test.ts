import { test } from "node:test";
import assert from "node:assert/strict";
import {
  construirLlmsTxt,
  construirOfertaAgente,
  consultarApartadoAgente,
  crearAlmacenMemoria,
  procesarApartadoAgente,
} from "../src/agente.ts";
import { PagosCoDiMock } from "../src/pagos/mock.ts";
import { PagosCoDiPey, interpretarEventoPey } from "../src/pagos/pey.ts";
import type { EnvModo } from "../src/modo.ts";

const ORIGEN = "https://inscripcion-codi.noisy-shape-4fc9.workers.dev";
const ENV_MOCK: EnvModo = { PAGOS_PROVEEDOR: "mock" };
const ENV_PEY: EnvModo = {
  PAGOS_PROVEEDOR: "pey",
  PEY_MONTO_PRUEBA_MXN: "0.01",
  PEY_BENEFICIARIO: "Ramón Orraca Lascurain (CLABE de pruebas de pey)",
};

async function llamarApartar(opciones: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  ruta?: string;
  env?: EnvModo;
  almacen: ReturnType<typeof crearAlmacenMemoria>;
  pagos: PagosCoDiMock | PagosCoDiPey;
}) {
  const { body = {}, headers = {}, ruta = "/api/agente/apartar", env = ENV_MOCK, almacen, pagos } = opciones;
  const url = new URL(ORIGEN + ruta);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const res = await procesarApartadoAgente({
    req,
    body,
    url,
    env,
    obtenerAlmacen: () => almacen,
    pagos,
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, unknown> };
}

test("/agente/oferta.json y /llms.txt exponen programas, colegiaturas, cupo y protocolo 402 CoDi en MXN", () => {
  const oferta = construirOfertaAgente(ENV_MOCK, ORIGEN);
  assert.equal(oferta.schema, "inscrito.agent-offer.v1");
  assert.equal(oferta.pago.rail, "CoDi");
  assert.equal(oferta.pago.currency, "MXN");
  assert.equal(oferta.pago.commission_pct, 0);
  assert.equal(oferta.pago.http_status_sin_pago, 402);
  assert.ok(oferta.programas.length >= 5);

  const primaria1 = oferta.programas.find((p) => p.id === "1-primaria")!;
  assert.equal(primaria1.inscripcion_mxn, 4850);
  assert.equal(primaria1.colegiatura_mensual_mxn, 6200);
  assert.equal(primaria1.lugares_disponibles, 6);

  // En modo pey, el monto de cobro actual baja a $0.01 MXN y el beneficiario es el titular real de la CLABE.
  const ofertaPey = construirOfertaAgente(ENV_PEY, ORIGEN);
  assert.equal(ofertaPey.escuela.razon_social_beneficiario, "Ramón Orraca Lascurain (CLABE de pruebas de pey)");
  assert.equal(ofertaPey.programas.find((p) => p.id === "1-primaria")!.inscripcion_mxn, 0.01);

  const llms = construirLlmsTxt(ENV_MOCK, ORIGEN);
  assert.match(llms, /\/agente\/oferta\.json/);
  assert.match(llms, /\/api\/agente\/apartar/);
  assert.match(llms, /\/api\/inscripcion/);
  assert.match(llms, /HTTP 402 Payment Required/);
  assert.match(llms, /0% de comisión/);
});

test("flujo 402 CoDi en modo mock: apartar devuelve 402 Payment Required y al aprobar en banco repite y devuelve 200 Inscrito", async () => {
  const almacen = crearAlmacenMemoria();
  const mock = new PagosCoDiMock({ ahora: () => Math.floor(Date.now() / 1000) });

  // 1) El agente de IA pide apartar lugar sin pago previo → 402 Payment Required.
  const r402 = await llamarApartar({
    almacen,
    pagos: mock,
    body: { familia: "Familia Lombana", grado: "1-primaria", celular: "0000000042" },
  });
  assert.equal(r402.status, 402);
  assert.match(r402.headers.get("www-authenticate") ?? "", /^x402-codi /);
  assert.equal(r402.json.status, "payment_required");
  assert.equal(r402.json.amount_mxn, 4850);
  assert.equal(r402.json.currency, "MXN");
  assert.equal(r402.json.rail, "CoDi");
  assert.equal(r402.json.commission_pct, 0);
  assert.match(String(r402.json.codi_qr_id), /^DEMO/);
  assert.equal(r402.json.push_status, "qr_ready");
  assert.match(String(r402.json.approval_url), /escuela=demo-agente01/);
  assert.match(String(r402.json.poll_url), /\/api\/agente\/apartar\//);

  const token = String(r402.json.payment_token);
  const leadId = String(r402.json.lead_id);
  const qrId = String(r402.json.codi_qr_id);

  // 2) Si el agente consulta poll_url o repite POST antes de que el padre apruebe con Face ID → sigue en 402 con el mismo cobro.
  const pollPendiente = await consultarApartadoAgente({
    tokenCrudo: token,
    env: ENV_MOCK,
    origen: ORIGEN,
    obtenerAlmacen: () => almacen,
    pagos: mock,
  });
  assert.equal(pollPendiente.status, 402);
  const pollJson = (await pollPendiente.json()) as Record<string, unknown>;
  assert.equal(pollJson.codi_qr_id, qrId);

  const reintentoPendiente = await llamarApartar({
    almacen,
    pagos: mock,
    headers: { "X-Payment-Token": token },
  });
  assert.equal(reintentoPendiente.status, 402);
  assert.equal(reintentoPendiente.json.codi_qr_id, qrId);

  // 3) La familia aprueba en la app de su banco → llega el webhook firmado de CoDi y el tablero concilia.
  const { lead } = await almacen.lead(leadId);
  assert.ok(lead?.cobro);
  const evento = mock.simularAceptacion(lead.cobro, { escuelaId: "demo-agente01", leadId });
  const aplicacion = await almacen.aplicarPago("msg_402_1", interpretarEventoPey(evento));
  assert.equal(aplicacion.resultado.tipo, "conciliado");

  // 4) El agente repite la solicitud con el token (en header o en /api/inscripcion) → 200 OK «Inscrito».
  const r200 = await llamarApartar({
    almacen,
    pagos: mock,
    ruta: "/api/inscripcion",
    headers: { "X-Payment-Token": token },
  });
  assert.equal(r200.status, 200);
  assert.equal(r200.json.status, "inscrito");
  assert.equal(r200.json.etapa, "Inscrito · Pagado");
  const pago = r200.json.pago as Record<string, unknown>;
  assert.equal(pago.rail, "CoDi");
  assert.equal(pago.currency, "MXN");
  assert.equal(pago.amount_mxn, 4850);
  assert.equal(pago.commission_pct, 0);

  // Y el cupo disponible de 1° primaria en /agente/oferta.json baja de 6 a 5.
  const { leads } = await almacen.estado();
  const ofertaDespues = construirOfertaAgente(ENV_MOCK, ORIGEN, leads);
  assert.equal(ofertaDespues.programas.find((p) => p.id === "1-primaria")!.lugares_disponibles, 5);
});

test("flujo 402 CoDi en modo pey ($0.01 MXN): respalda con QR si no hay celular de prueba y concilia al consultar estadoCobro", async () => {
  const almacen = crearAlmacenMemoria();
  let estadoQr: "PENDING" | "PAID" = "PENDING";
  const llamadas: { url: string; method: string; body?: unknown }[] = [];

  const pey = new PagosCoDiPey({
    apiKey: "sk_live_prueba",
    fetcher: async (url, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      llamadas.push({ url, method, body });
      if (url.endsWith("/codi/qr") && method === "POST") {
        return new Response(JSON.stringify({ id: "357b2f0d9d", qrString: '{"IDC":"357b2f0d9d"}' }), { status: 201 });
      }
      if (url.includes("/transaction/codi/qr/357b2f0d9d")) {
        return new Response(
          JSON.stringify({
            items:
              estadoQr === "PAID"
                ? [{ id: "01TXPEYREAL", status: "PAID", amount: 0.01, datePaid: 1795000000, metadata: { trackingKey: "SPEI01" } }]
                : [],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    },
  });

  // Pide push en modo pey sin PEY_CELULAR_PRUEBA → cae en fallback_qr por $0.01 MXN en api.pey.mx.
  const r402 = await llamarApartar({
    almacen,
    pagos: pey,
    env: ENV_PEY,
    body: { familia: "Familia Prueba Pey", grado: "Kínder 2", medio: "push" },
  });
  assert.equal(r402.status, 402);
  assert.equal(r402.json.amount_mxn, 0.01);
  assert.equal(r402.json.codi_qr_id, "357b2f0d9d");
  assert.equal(r402.json.push_status, "fallback_qr");
  assert.equal(r402.json.beneficiario, "Ramón Orraca Lascurain (CLABE de pruebas de pey)");
  assert.equal((llamadas[0]!.body as Record<string, unknown>).amount, 0.01);

  // Cuando el banco reporta PAID en GET /transaction/codi/qr/{id}, el poll o reintento concilia y responde 200 OK.
  estadoQr = "PAID";
  const r200 = await llamarApartar({
    almacen,
    pagos: pey,
    env: ENV_PEY,
    body: { payment_token: r402.json.payment_token },
  });
  assert.equal(r200.status, 200);
  assert.equal(r200.json.status, "inscrito");
  const pago = r200.json.pago as Record<string, unknown>;
  assert.equal(pago.amount_mxn, 0.01);
  assert.equal(pago.transaction_id, "01TXPEYREAL");
  assert.equal(pago.clave_rastreo, "SPEI01");
});

test("validaciones del endpoint de agentes: celular inválido → 422, escuela inválida → 400, token desconocido → 404", async () => {
  const almacen = crearAlmacenMemoria();
  const mock = new PagosCoDiMock();

  const celMalo = await llamarApartar({ almacen, pagos: mock, body: { celular: "123" } });
  assert.equal(celMalo.status, 422);

  const escMala = await llamarApartar({ almacen, pagos: mock, body: { escuela: "otra-escuela" } });
  assert.equal(escMala.status, 400);

  const noExiste = await llamarApartar({ almacen, pagos: mock, body: { payment_token: "demo-agente01.lead-inexistente" } });
  assert.equal(noExiste.status, 404);
});
