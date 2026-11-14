import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, publicEncrypt, constants, randomBytes } from "node:crypto";
import {
  CONTACTOS_DEMO,
  cifrarComoWhatsApp,
  descifrarRespuestaComoWhatsApp,
  descifrarSolicitud,
  escuelaDeFlowToken,
  firmarMeta,
  importarLlavePrivada,
  limpiarConcepto,
  llavePublicaDe,
  nuevoFlowToken,
  procesarFlow,
  validarFormularioCobro,
  verificarFirmaMeta,
  type Decision,
  type SolicitudFlow,
} from "../src/whatsapp-flow.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const APP_SECRET = "app-secret-de-prueba";

/** «Meta» escrito con node:crypto (otra implementación), como en el ejemplo de Node de la documentación. */
function cifrarComoMetaConNode(payload: unknown) {
  const llave = randomBytes(16);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", llave, iv);
  const datos = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  const llaveCifrada = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, llave);
  const cuerpo = JSON.stringify({
    encrypted_flow_data: datos.toString("base64"),
    encrypted_aes_key: llaveCifrada.toString("base64"),
    initial_vector: iv.toString("base64"),
  });
  return { cuerpo, llave, iv };
}

function descifrarRespuestaConNode(b64: string, llave: Buffer, iv: Buffer) {
  const datos = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-128-gcm", llave, Buffer.from(iv.map((b) => b ^ 0xff)));
  d.setAuthTag(datos.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(datos.subarray(0, -16)), d.final()]).toString("utf8"));
}

const firmaNode = (cuerpo: string) => "sha256=" + createHmac("sha256", APP_SECRET).update(cuerpo).digest("hex");

async function endpoint(manejar: (s: SolicitudFlow) => Promise<Decision> = async () => ({ respuesta: { screen: "COBRO", data: {} } })) {
  const llavePrivada = await importarLlavePrivada(PEM);
  return (cuerpo: string, firma: string | null = firmaNode(cuerpo)) =>
    procesarFlow({ cuerpo, firma }, { appSecret: APP_SECRET, llavePrivada, manejar });
}

test("firma X-Hub-Signature-256: igual a la de node:crypto; rechaza otra", async () => {
  const cuerpo = '{"a":1}';
  assert.equal(await firmarMeta(APP_SECRET, cuerpo), firmaNode(cuerpo));
  assert.ok(await verificarFirmaMeta(APP_SECRET, firmaNode(cuerpo), cuerpo));
  assert.ok(!(await verificarFirmaMeta(APP_SECRET, firmaNode(cuerpo), '{"a":2}')));
  assert.ok(!(await verificarFirmaMeta("otro", firmaNode(cuerpo), cuerpo)));
  assert.ok(!(await verificarFirmaMeta(APP_SECRET, null, cuerpo)));
});

test("descifra una solicitud cifrada por node:crypto (RSA-OAEP-256 + AES-128-GCM) y responde con el IV invertido", async () => {
  const payload = { version: "3.0", action: "data_exchange", screen: "COBRO", data: { monto: "350" }, flow_token: "t" };
  const { cuerpo, llave, iv } = cifrarComoMetaConNode(payload);
  let recibido: SolicitudFlow | undefined;
  const ep = await endpoint(async (s) => {
    recibido = s;
    return { respuesta: { screen: "SUCCESS", data: { ok: true } } };
  });
  const r = await ep(cuerpo);
  assert.equal(r.status, 200);
  assert.equal(r.tipo, "text/plain");
  assert.deepEqual(recibido, payload);
  assert.deepEqual(descifrarRespuestaConNode(r.cuerpo, llave, iv), { screen: "SUCCESS", data: { ok: true } });
});

test("ida y vuelta con el cliente simulado (WebCrypto) y la pública derivada de la privada", async () => {
  const privada = await importarLlavePrivada(PEM);
  const publica = await llavePublicaDe(privada);
  const { cuerpo, llave, iv } = await cifrarComoWhatsApp(publica, { version: "3.0", action: "INIT", flow_token: "x" });
  const d = await descifrarSolicitud(privada, cuerpo);
  assert.deepEqual(d.payload, { version: "3.0", action: "INIT", flow_token: "x" });
  const ep = await endpoint();
  const texto = JSON.stringify(cuerpo);
  const r = await ep(texto);
  assert.deepEqual(await descifrarRespuestaComoWhatsApp(r.cuerpo, llave, iv), { screen: "COBRO", data: {} });
});

test("códigos de Meta: 432 firma inválida · 421 no se puede descifrar · 427 flow_token inválido", async () => {
  const ep = await endpoint(async () => ({ tokenInvalido: "Este cobro ya se envió" }));
  const { cuerpo } = cifrarComoMetaConNode({ version: "3.0", action: "data_exchange", data: {}, flow_token: "t" });
  assert.equal((await ep(cuerpo, "sha256=00")).status, 432);
  assert.equal((await ep(cuerpo, null)).status, 432);
  const roto = JSON.stringify({ ...JSON.parse(cuerpo), encrypted_flow_data: Buffer.from("basura").toString("base64") });
  assert.equal((await ep(roto)).status, 421);
  assert.equal((await ep("{}")).status, 421);
  const r = await ep(cuerpo);
  assert.equal(r.status, 427);
  assert.deepEqual(JSON.parse(r.cuerpo), { error_msg: "Este cobro ya se envió" });
});

test("health check (ping) y aviso de error del cliente no tocan la lógica de negocio", async () => {
  const ep = await endpoint(async () => assert.fail("no debe llamarse"));
  const ping = cifrarComoMetaConNode({ version: "3.0", action: "ping" });
  assert.deepEqual(descifrarRespuestaConNode((await ep(ping.cuerpo)).cuerpo, ping.llave, ping.iv), { data: { status: "active" } });
  const err = cifrarComoMetaConNode({ version: "3.0", action: "data_exchange", flow_token: "t", data: { error: "x", error_message: "y" } });
  assert.deepEqual(descifrarRespuestaConNode((await ep(err.cuerpo)).cuerpo, err.llave, err.iv), { data: { acknowledged: true } });
});

test("llave PKCS#1 → mensaje claro para convertirla", async () => {
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  await assert.rejects(importarLlavePrivada(pkcs1), /PKCS#8/);
});

const base = { monto: "350", concepto: "Colegiatura noviembre", contacto: "mariana", vigencia: "30" };

test("formulario válido: contacto del directorio", () => {
  const r = validarFormularioCobro(base);
  assert.deepEqual(r, {
    ok: true,
    contacto: { nombre: CONTACTOS_DEMO[0]!.nombre, celular: CONTACTOS_DEMO[0]!.celular },
    montoMXN: 350,
    concepto: "Colegiatura noviembre",
    vigenciaSegundos: 1800,
  });
});

test("formulario: monto con $ y comas, dos decimales, > 0 y ≤ $12,000", () => {
  const monto = (m: string) => validarFormularioCobro({ ...base, monto: m });
  assert.equal((monto("$1,250.50") as { montoMXN: number }).montoMXN, 1250.5);
  for (const m of ["", "0", "-5", "12.345", "abc", "12000.01"]) assert.equal(monto(m).ok, false, m);
  assert.equal(monto("12000").ok, true);
});

test("formulario: concepto obligatorio, ≤ 40 caracteres, sin acentos para la orden SPEI", () => {
  assert.equal(validarFormularioCobro({ ...base, concepto: "x".repeat(40) }).ok, true);
  const largo = validarFormularioCobro({ ...base, concepto: "x".repeat(41) });
  assert.deepEqual(largo, { ok: false, campo: "concepto", error: "El concepto admite máximo 40 caracteres" });
  assert.equal(validarFormularioCobro({ ...base, concepto: "   " }).ok, false);
  assert.equal(limpiarConcepto("Inscripción niño 2° 🎒"), "Inscripcion nino 2");
});

test("formulario: otro número de 10 dígitos; en la demo solo ficticios (0000…)", () => {
  const otro = (celular: string, soloFicticios = true) =>
    validarFormularioCobro({ ...base, contacto: "otro", celular }, { soloFicticios });
  const ok = otro("0000 000 777");
  assert.ok(ok.ok && ok.contacto.celular === "0000000777" && ok.contacto.nombre === "Contacto •• •••• ••77");
  assert.equal(otro("123").ok, false);
  assert.deepEqual(otro("5512345678"), { ok: false, campo: "celular", error: "En la demo usa un número ficticio que empiece con 0000" });
  assert.equal(otro("5512345678", false).ok, true);
  assert.equal(validarFormularioCobro({ ...base, contacto: "nadie" }).ok, false);
});

test("formulario: vigencia solo 30 o 60 min", () => {
  assert.equal((validarFormularioCobro({ ...base, vigencia: "60" }) as { vigenciaSegundos: number }).vigenciaSegundos, 3600);
  for (const v of ["", "15", "45", "90"]) assert.equal(validarFormularioCobro({ ...base, vigencia: v }).ok, false, v);
});

test("flow_token: impredecible y ligado a la sesión de demo", () => {
  const t = nuevoFlowToken("demo-abcdefgh12");
  assert.match(t, /^demo-abcdefgh12\.[0-9a-f]{32}$/);
  assert.notEqual(t, nuevoFlowToken("demo-abcdefgh12"));
  assert.equal(escuelaDeFlowToken(t), "demo-abcdefgh12");
  for (const malo of ["", "demo-abc.123", "x.0123456789abcdef0123456789abcdef", null]) assert.equal(escuelaDeFlowToken(malo), undefined);
});
