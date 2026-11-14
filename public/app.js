// Demo «Inscripción con CoDi». Sin frameworks: el estado del CRM vive en el Worker
// (Durable Object) y esta página solo lo dibuja. La conversación es un guion fijo.

const $ = (s) => document.querySelector(s);
const pesos = (n) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const hora = (ms = Date.now()) => new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const horaSeg = (ms) => new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── Sesión de demo: un tablero (Durable Object) por visitante ──
const params = new URLSearchParams(location.search);
function nuevaEscuela() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  const r = crypto.getRandomValues(new Uint8Array(12));
  return "demo-" + Array.from(r, (b) => a[b % a.length]).join("");
}
let escuela = params.get("escuela") || sessionStorage.getItem("escuela") || nuevaEscuela();
sessionStorage.setItem("escuela", escuela);

async function api(ruta, cuerpo) {
  const res = await fetch(ruta, cuerpo
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ escuela, ...cuerpo }) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

// ── Chat ──
const chat = $("#chat");
function burbuja(quien, html) {
  const d = document.createElement("div");
  d.className = "msg " + quien;
  d.innerHTML = html + `<span class="hora">${hora()}</span>`;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}
async function agente(html, pausa = 900) {
  const t = burbuja("escribiendo", "escribiendo…");
  await esperar(pausa);
  t.remove();
  return burbuja("agente", html);
}
function respuestas(opciones) {
  const cont = $("#respuestas");
  cont.innerHTML = "";
  for (const [texto, accion] of opciones) {
    const b = document.createElement("button");
    b.textContent = texto;
    b.onclick = async () => {
      cont.innerHTML = "";
      burbuja("familia", esc(texto));
      await accion();
    };
    cont.appendChild(b);
  }
  chat.scrollTop = chat.scrollHeight; // las respuestas encogen el chat: deja visible el último mensaje
}

// ── Guion ──
let lead = null;
let cobro = null;
let avisado = false;
let config = null; // /api/config: cuota, razón social, aviso de privacidad
// Misma forma que el mensaje del servidor: «14/11/2026 15:30», hora del centro de México.
const fechaHora = (seg) => new Date(seg * 1000).toLocaleString("es-MX", {
  timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).replace(",", "");
const conBr = (texto) => esc(texto).replace(/\n/g, "<br>");

function inicio() {
  respuestas([["Hola, quiero informes de inscripción para 1° de primaria", pedirInformes]]);
}

async function pedirInformes() {
  lead = await api("/api/leads", {});
  refrescar();
  await agente(
    "¡Hola! Soy el asistente de admisiones del <b>Colegio Aurora</b> (demo).\n" +
    `Para <b>1° de primaria, ciclo 2027-28</b>:\n• Inscripción: <b>${pesos(config.cuota.montoMXN)}</b>\n• Colegiatura: $3,900 al mes\n` +
    "<small>(montos ficticios)</small>¿Quieres que te aparte un lugar? Te mando el cobro CoDi a la app de tu banco, sin comisión." +
    `<small>${esc(config.avisoPrivacidad)}</small>`,
  );
  respuestas([[`Sí, aparta el lugar. Pago los ${pesos(config.cuota.montoMXN)}`, enviarPush]]);
}

function tarjetaCobro(c, extra = "") {
  return `<div class="tarjeta" data-cobro="${esc(c.id)}"><b>${c.medio === "push" ? "Cobro CoDi en tu banco" : "QR CoDi"}</b>` +
    `${extra}${pesos(c.montoMXN)} · ref ${esc(c.referencia)}<small>Vale hasta ${fechaHora(c.expiraEn)}</small></div>`;
}

async function enviarPush() {
  // El monto que la familia acaba de confirmar en el chat: el servidor rechaza el cobro si no es igual.
  const r = await api("/api/cobros", { leadId: lead.id, medio: "push", montoConfirmadoMXN: config.cuota.montoMXN });
  cobro = r.cobro;
  refrescar();
  // Primero el WhatsApp con los datos exactos; después llega el push del banco.
  await agente(conBr(r.mensaje) + tarjetaCobro(cobro));
  await esperar(900);
  notificacionBanco(r.beneficiario);
  respuestas([["(Demo) No contesto y pasan los 30 min", vencer]]);
}

function notificacionBanco(beneficiario) {
  $("#banner-txt").textContent = `${beneficiario} te envió un cobro CoDi de ${pesos(cobro.montoMXN)}`;
  $("#banner").hidden = false;
  $("#h-monto").textContent = pesos(cobro.montoMXN);
  $("#h-folio").textContent = cobro.folioCodi || "—";
  $("#h-benef").textContent = beneficiario;
  $("#h-concepto").textContent = cobro.concepto;
  $("#h-ref").textContent = cobro.referencia;
  $("#h-vig").textContent = "hasta " + fechaHora(cobro.expiraEn);
}
function cerrarBanco() {
  $("#banner").hidden = $("#hoja").hidden = true;
}
$("#banner").onclick = () => {
  $("#banner").hidden = true;
  $("#hoja").hidden = false;
};
const botonesHoja = () => ["#h-aceptar", "#h-rechazar", "#h-posponer"].map((s) => $(s));
$("#h-aceptar").onclick = async () => {
  for (const b of botonesHoja()) b.disabled = true;
  $("#h-aceptar").textContent = "Transfiriendo…";
  try {
    await aceptar();
  } finally {
    $("#hoja").hidden = true;
    for (const b of botonesHoja()) b.disabled = false;
    $("#h-aceptar").textContent = "Aceptar";
  }
};
$("#h-rechazar").onclick = async () => {
  // Pey no avisa de rechazos: el colegio se entera al vencer (o porque la familia lo dice en el chat).
  cerrarBanco();
  respuestas([["Lo rechacé / no me salió en el banco, ¿me lo mandas en QR?", enviarQR]]);
};
$("#h-posponer").onclick = () => {
  $("#hoja").hidden = true;
  $("#banner-txt").textContent = `Cobro pospuesto · vale hasta ${fechaHora(cobro.expiraEn)} · tócalo para verlo`;
  $("#banner").hidden = false;
};

async function enviarQR() {
  const r = await api("/api/cobros", { leadId: lead.id, medio: "qr", montoConfirmadoMXN: config.cuota.montoMXN });
  cobro = r.cobro;
  cerrarBanco();
  refrescar();
  const m = await agente(
    conBr(r.mensaje) +
    "\n<small>Es un cobro nuevo, con su propia referencia; el anterior ya no sirve.</small>" +
    `<div class="tarjeta" data-cobro="${esc(cobro.id)}"><div class="qr">${r.qrSvg}</div><b>QR CoDi</b>${pesos(cobro.montoMXN)} · ref ${esc(cobro.referencia)}` +
    `<small>${esc(r.beneficiario)} · vale hasta ${fechaHora(cobro.expiraEn)}</small>` +
    `<small>QR de demostración: no lo pagues con un banco real.</small>` +
    `<button class="primario">Simular: escaneé y pagué</button></div>`,
  );
  const b = m.querySelector("button");
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = "Transfiriendo…";
    await aceptar();
  };
  respuestas([["(Demo) No lo pago y pasan los 30 min", vencer]]);
}

async function vencer() {
  // Simula que pasó la vigencia: el servidor consulta al proveedor (en Pey: GET /transaction/{id})
  // y, si sigue PENDING, marca el cobro «vencido o rechazado». Nunca se reutiliza.
  const r = await api("/api/demo/vencer", { leadId: lead.id });
  await refrescar();
  if (r.lead?.etapa === "pagado") return;
  cerrarBanco();
  const viejo = cobro;
  for (const t of document.querySelectorAll(`[data-cobro="${CSS.escape(viejo.id)}"]`)) {
    t.classList.add("vencida");
    t.querySelector("button")?.remove();
  }
  await agente(
    `⏰ Tu cobro de ${pesos(viejo.montoMXN)} (ref ${esc(viejo.referencia)}) <b>venció</b> sin pago: no se te cobró nada.\n` +
    "Por seguridad no reutilizo cobros vencidos. ¿Te mando uno nuevo?",
  );
  respuestas([
    ["Sí, mándamelo otra vez al banco", enviarPush],
    ["Mejor por QR", enviarQR],
  ]);
}

async function aceptar() {
  // El navegador NO marca el pago: le pide al Worker emitir el webhook firmado,
  // que llega por HTTP a /webhooks/codi. El tablero se entera por su propio estado.
  const r = await api("/api/demo/aceptar", { leadId: lead.id });
  const w = r.webhook;
  if (w.status !== 200) throw new Error("webhook " + w.status);
  await refrescar();
}

async function confirmarEnChat(l) {
  if (avisado) return;
  avisado = true;
  $("#respuestas").innerHTML = "";
  cerrarBanco();
  for (const t of document.querySelectorAll("[data-cobro]")) {
    if (t.classList.contains("vencida")) continue;
    t.classList.add("pagada");
    t.querySelector("b")?.insertAdjacentText("beforeend", " · Pagado ✓");
    t.querySelector("button")?.remove();
  }
  await agente(
    `✅ <b>¡Pago recibido!</b> ${pesos(l.pago.montoMXN)} por CoDi, sin comisión.\n` +
    `${l.pago.medio === "qr" ? "Id del QR CoDi (IDC)" : "Folio CoDi"}: ${esc(l.pago.folioCodi || "—")}\n` +
    `Clave de rastreo: ${esc(l.pago.claveRastreo || "—")}\n` +
    `Desde tu cuenta CLABE ${esc(l.pago.clabeOrdenante || "—")}\n` +
    `Beneficiario: ${esc(config.escuela.razonSocial)}\n` +
    "Tu lugar en 1° de primaria quedó <b>inscrito</b>. ¡Bienvenidos al Colegio Aurora!",
    700,
  );
}

// ── Tablero ──
const ETAPAS = [
  ["nuevo", "Nuevo"],
  ["informes", "Informes enviados"],
  ["cobro_enviado", "Cobro CoDi enviado"],
  ["pagado", "Inscrito · Pagado"],
];
const etapaPrevia = new Map();

function tarjeta(l) {
  let detalle = "";
  if (l.enRevision) {
    detalle = `<div class="detalle vencido">⚠ pago no coincide con el cobro · revisión</div>`;
  } else if (l.etapa === "cobro_enviado" && l.cobro && l.cobro.estado === "vencido_o_rechazado") {
    detalle = `<div class="detalle vencido">vencido o rechazado · ref ${esc(l.cobro.referencia)} · mandar uno nuevo</div>`;
  } else if (l.etapa === "cobro_enviado" && l.cobro) {
    detalle = `<div class="detalle esperando">${pesos(l.cobro.montoMXN)} · ${l.cobro.medio === "push" ? "push" : "QR"} · ref ${esc(l.cobro.referencia)}</div>`;
  } else if (l.etapa === "cobro_enviado") {
    detalle = `<div class="detalle esperando">esperando pago</div>`;
  } else if (l.etapa === "pagado" && l.pago) {
    detalle = `<div class="detalle">✓ ${pesos(l.pago.montoMXN)} · CoDi ${l.pago.medio === "push" ? "push" : "QR"}<br>sin comisión` +
      (l.pago.claveRastreo ? ` · rastreo ${esc(l.pago.claveRastreo)}` : "") + "</div>";
  }
  const movido = etapaPrevia.has(l.id) && etapaPrevia.get(l.id) !== l.etapa;
  etapaPrevia.set(l.id, l.etapa);
  return `<div class="card ${l.demo ? "demo" : ""} ${l.etapa === "pagado" ? "pagado" : ""} ${movido ? "movido" : ""}">
    <b>${esc(l.familia)}</b><div class="canal">${esc(l.grado)} · ${esc(l.canal)}</div>${detalle}</div>`;
}

function dibujar(estado) {
  const leads = estado.leads.map((l) => (l.etapa === "revision" ? { ...l, etapa: "cobro_enviado", enRevision: true } : l));
  $("#tablero").innerHTML = ETAPAS.map(([id, nombre]) => {
    const deEtapa = leads.filter((l) => l.etapa === id);
    return `<div class="col ${id}"><h3>${nombre}<span>${deEtapa.length}</span></h3>${deEtapa.map(tarjeta).join("")}</div>`;
  }).join("");
  $("#bitacora").innerHTML = estado.bitacora.slice(-7).reverse().map((e) =>
    `<li class="${e.tipo === "webhook" || e.tipo === "ntfy" || e.tipo === "vencimiento" ? (e.ok ? "ok" : "error") : ""}"><time>${horaSeg(e.en)}</time>${esc(e.texto)}</li>`,
  ).join("") || "<li>Escribe en el chat para empezar.</li>";

  const mio = estado.leads.find((l) => l.demo);
  if (mio) lead = lead || mio;
  if (mio?.etapa === "pagado" && lead && cobro) confirmarEnChat(mio);
}

async function refrescar() {
  try {
    dibujar(await api(`/api/tablero?escuela=${encodeURIComponent(escuela)}`));
    $("#vivo").textContent = "● en vivo";
  } catch {
    $("#vivo").textContent = "○ sin conexión";
  }
}

// ── ntfy ──
async function configurar() {
  const c = await api("/api/config");
  config = c;
  $("#privacidad").textContent = c.avisoPrivacidad;
  $("#proveedor").textContent = c.proveedor === "mock" ? "CoDi simulado" : "CoDi vía Pey";
  if (c.ntfy) {
    $("#ntfy-qr").innerHTML = c.ntfy.qr;
    $("#ntfy-tema").textContent = "tema: " + c.ntfy.tema;
    $("#ntfy-servidor").textContent = "servidor: " + c.ntfy.servidor;
  } else {
    $("#btn-ntfy").hidden = true;
  }
}
$("#btn-ntfy").onclick = () => {
  const p = $("#ntfy");
  p.hidden = !p.hidden;
  $("#btn-ntfy").setAttribute("aria-expanded", String(!p.hidden));
};
$("#btn-reiniciar").onclick = () => {
  sessionStorage.removeItem("escuela");
  location.href = new URLSearchParams(location.search).get("modo") === "contacto" ? "/?modo=contacto" : "/";
};

// ── Arranque ──
(async () => {
  await configurar();
  const estado = await api("/api/demo/iniciar", {});
  dibujar(estado);
  const mio = estado.leads.find((l) => l.demo);
  if (mio?.etapa === "pagado") {
    burbuja("agente", "✅ Esta demo ya terminó: la inscripción quedó pagada. Toca <b>Reiniciar</b> para verla otra vez.");
  } else if (mio) {
    burbuja("agente", "Esta demo se quedó a medias. Toca <b>Reiniciar</b> para empezar de nuevo.");
  } else {
    inicio();
  }
  setInterval(refrescar, 1500);
})();
