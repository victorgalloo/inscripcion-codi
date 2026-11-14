// Demo «Inscripción con CoDi». Sin frameworks: el estado del CRM vive en el Worker
// (Durable Object) y esta página solo lo dibuja. La conversación es un guion fijo.

const $ = (s) => document.querySelector(s);
const pesos = (n) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const hora = (ms = Date.now()) => new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
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
}

// ── Guion ──
let lead = null;
let cobro = null;
let avisado = false;

function inicio() {
  respuestas([["Hola, quiero informes de inscripción para 1° de primaria", pedirInformes]]);
}

async function pedirInformes() {
  lead = await api("/api/leads", {});
  refrescar();
  await agente(
    "¡Hola! Soy el asistente de admisiones del <b>Colegio Aurora</b> (demo).\n" +
    "Para <b>1° de primaria, ciclo 2027-28</b>:\n• Inscripción: <b>$4,850</b>\n• Colegiatura: $3,900 al mes\n" +
    "<small>(montos ficticios)</small>\n¿Quieres que te aparte un lugar?",
  );
  respuestas([["Sí, ¿cómo pago la inscripción?", enviarPush]]);
}

async function enviarPush() {
  const r = await api("/api/cobros", { leadId: lead.id, medio: "push" });
  cobro = r.cobro;
  refrescar();
  await agente(
    `Listo. Te envié un <b>cobro CoDi</b> a la app de tu banco (celular ${esc(cobro.celular)}).\n` +
    "Ábrelo y toca <b>Aceptar</b>: es transferencia inmediata y sin comisión." +
    `<div class="tarjeta"><b>Paga tu inscripción</b>${pesos(cobro.montoMXN)} · ref ${cobro.referencia}` +
    `<small>Vence a las ${hora(cobro.expiraEn * 1000)}</small></div>`,
  );
  await esperar(900);
  notificacionBanco(r.beneficiario);
}

function notificacionBanco(beneficiario) {
  $("#banner-txt").textContent = `${beneficiario} te envió un cobro de ${pesos(cobro.montoMXN)}`;
  $("#banner").hidden = false;
  $("#h-monto").textContent = pesos(cobro.montoMXN);
  $("#h-benef").textContent = beneficiario;
  $("#h-concepto").textContent = cobro.concepto;
  $("#h-ref").textContent = cobro.referencia;
  $("#h-vig").textContent = "hasta las " + hora(cobro.expiraEn * 1000);
}
$("#banner").onclick = () => {
  $("#banner").hidden = true;
  $("#hoja").hidden = false;
};
$("#h-aceptar").onclick = async () => {
  $("#h-aceptar").disabled = $("#h-rechazar").disabled = true;
  $("#h-aceptar").textContent = "Transfiriendo…";
  try {
    await aceptar();
  } finally {
    $("#hoja").hidden = true;
    $("#h-aceptar").disabled = $("#h-rechazar").disabled = false;
    $("#h-aceptar").textContent = "Aceptar";
  }
};
$("#h-rechazar").onclick = async () => {
  $("#hoja").hidden = true;
  respuestas([["No me llegó al banco, ¿me lo mandas en QR?", enviarQR]]);
};

async function enviarQR() {
  const r = await api("/api/cobros", { leadId: lead.id, medio: "qr" });
  cobro = r.cobro;
  refrescar();
  const m = await agente(
    "Claro. Escanea este <b>QR CoDi</b> desde la app de tu banco (misma referencia, mismo monto):" +
    `<div class="tarjeta"><div class="qr">${r.qrSvg}</div>${pesos(cobro.montoMXN)} · ref ${cobro.referencia}` +
    `<small>QR de demostración: no lo pagues con un banco real.</small>` +
    `<button class="primario">Simular: escaneé y pagué</button></div>`,
  );
  const b = m.querySelector("button");
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = "Transfiriendo…";
    await aceptar();
  };
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
  await agente(
    `✅ <b>¡Pago recibido!</b> ${pesos(l.pago.montoMXN)} por CoDi, sin comisión.\n` +
    `Clave de rastreo: ${esc(l.pago.claveRastreo || "—")}\n` +
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
  if (l.etapa === "cobro_enviado" && l.cobro) {
    detalle = `<div class="detalle esperando">${pesos(l.cobro.montoMXN)} · ${l.cobro.medio === "push" ? "push" : "QR"} · ref ${l.cobro.referencia}</div>`;
  } else if (l.etapa === "cobro_enviado") {
    detalle = `<div class="detalle esperando">esperando pago</div>`;
  } else if (l.etapa === "pagado" && l.pago) {
    detalle = `<div class="detalle">✓ ${pesos(l.pago.montoMXN)} · CoDi ${l.pago.medio === "push" ? "push" : "QR"} · comisión $0` +
      (l.pago.claveRastreo ? `<br>rastreo ${esc(l.pago.claveRastreo)}` : "") + "</div>";
  }
  const movido = etapaPrevia.has(l.id) && etapaPrevia.get(l.id) !== l.etapa;
  etapaPrevia.set(l.id, l.etapa);
  return `<div class="card ${l.demo ? "demo" : ""} ${l.etapa === "pagado" ? "pagado" : ""} ${movido ? "movido" : ""}">
    <b>${esc(l.familia)}</b><div class="canal">${esc(l.grado)} · ${esc(l.canal)}</div>${detalle}</div>`;
}

function dibujar(estado) {
  const leads = estado.leads.map((l) => (l.etapa === "revision" ? { ...l, etapa: "cobro_enviado" } : l));
  $("#tablero").innerHTML = ETAPAS.map(([id, nombre]) => {
    const deEtapa = leads.filter((l) => l.etapa === id);
    return `<div class="col ${id}"><h3>${nombre}<span>${deEtapa.length}</span></h3>${deEtapa.map(tarjeta).join("")}</div>`;
  }).join("");
  $("#bitacora").innerHTML = estado.bitacora.slice(-7).reverse().map((e) =>
    `<li class="${e.tipo === "webhook" || e.tipo === "ntfy" ? (e.ok ? "ok" : "error") : ""}"><time>${hora(e.en)}</time>${esc(e.texto)}</li>`,
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
  $("#proveedor").textContent = c.proveedor === "mock" ? "CoDi simulado" : "CoDi vía Pey";
  if (c.ntfy) {
    $("#ntfy-qr").innerHTML = c.ntfy.qr;
    $("#ntfy-tema").textContent = c.ntfy.tema;
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
  location.href = "/";
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
