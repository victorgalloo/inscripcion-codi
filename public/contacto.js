// Modo «Cobrar a un contacto»: el personal del colegio llena un WhatsApp Flow («Cobrar con CoDi»),
// el Flow llega cifrado y firmado al endpoint /webhooks/whatsapp-flow del Worker, que manda el cobro
// CoDi push al celular del contacto. El contacto paga con un botón y quien cobró recibe el aviso
// en WhatsApp y por ntfy. Todo el estado vive en el Worker; aquí solo se dibuja.

const $ = (s) => document.querySelector(s);
const pesos = (n) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const hora = (ms = Date.now()) => new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const horaSeg = (ms) => new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const conBr = (t) => esc(t).replace(/\n/g, "<br>");
const fechaHora = (seg) => new Date(seg * 1000).toLocaleString("es-MX", {
  timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

// La sesión (tablero) la crea app.js, que corre antes que este módulo.
const escuela = () => sessionStorage.getItem("escuela");

async function api(ruta, cuerpo) {
  const res = await fetch(ruta, cuerpo
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ escuela: escuela(), ...cuerpo }) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

// ── Selector de modo ──
const tabs = { inscripcion: $("#tab-inscripcion"), contacto: $("#tab-contacto") };
let iniciado = false;
function ponerModo(modo) {
  for (const [m, b] of Object.entries(tabs)) b.setAttribute("aria-selected", String(m === modo));
  $("#modo-inscripcion").hidden = modo !== "inscripcion";
  $("#modo-contacto").hidden = modo !== "contacto";
  const u = new URL(location.href);
  if (modo === "contacto") u.searchParams.set("modo", "contacto");
  else u.searchParams.delete("modo");
  history.replaceState(null, "", u);
  if (modo === "contacto" && !iniciado) {
    iniciado = true;
    arrancar();
  }
}
tabs.inscripcion.onclick = () => ponerModo("inscripcion");
tabs.contacto.onclick = () => ponerModo("contacto");

// ── Chat de quien cobra ──
const chat = $("#c-chat");
function burbuja(quien, html) {
  const d = document.createElement("div");
  d.className = "msg " + quien;
  d.innerHTML = html + `<span class="hora">${hora()}</span>`;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}
async function bot(html, pausa = 700) {
  const t = burbuja("escribiendo", "escribiendo…");
  await esperar(pausa);
  t.remove();
  return burbuja("agente", html);
}
function respuestas(opciones) {
  const cont = $("#c-respuestas");
  cont.innerHTML = "";
  for (const [texto, accion] of opciones) {
    const b = document.createElement("button");
    b.textContent = texto;
    b.onclick = async () => {
      cont.innerHTML = "";
      burbuja("familia", esc(texto));
      try {
        await accion();
      } catch (e) {
        await bot(`⚠ ${esc(e.message)}`);
        respuestas([["Cobrar a un contacto", pedirFlow]]);
      }
    };
    cont.appendChild(b);
  }
  chat.scrollTop = chat.scrollHeight;
}

// ── Estado ──
let config = null;
let flowToken = null;
let cobroId = null; // el cobro que está en el celular del contacto
const avisados = new Set();
const creados = new Set(); // cobros creados desde esta página (solo de esos se avisa el pago en el chat)

async function arrancar() {
  config = await api("/api/config");
  burbuja(
    "agente",
    "Hola 👋 Soy el bot de cobros del <b>Colegio Aurora</b> (demo).\n" +
    "Cóbrale por CoDi a <b>cualquier contacto</b>: le llega el cobro a la app de su banco, con todo prellenado y sin comisión." +
    (config.flowConfigurado ? "" : "\n<small>⚠ El endpoint del Flow no está configurado en este servidor.</small>"),
  );
  respuestas([["Cobrar a un contacto", pedirFlow]]);
  setInterval(refrescar, 1500);
  setInterval(() => ($("#r-reloj").textContent = hora()), 10_000);
  $("#r-reloj").textContent = hora();
  refrescar();
}

async function pedirFlow() {
  // En producción: Cloud API manda un mensaje interactivo de tipo "flow" con un flow_token nuevo.
  const r = await api("/api/contactos/flow", {});
  flowToken = r.flowToken;
  const m = await bot(
    "Llena el formulario y mando el cobro a la app del banco de tu contacto." +
    `<button class="flow-cta">📋 Cobrar con CoDi</button>`,
  );
  m.querySelector("button").onclick = abrirFlow;
}

// ── WhatsApp Flow ──
const form = $("#flow");
const campos = { monto: $("#f-monto"), concepto: $("#f-concepto"), contacto: $("#f-contacto"), celular: $("#f-celular") };

function errorFlow(texto, campo) {
  for (const c of Object.values(campos)) c.classList.remove("invalido");
  const e = $("#flow-error");
  e.hidden = !texto;
  e.textContent = texto || "";
  if (campo && campos[campo]) {
    campos[campo].classList.add("invalido");
    campos[campo].focus();
  }
}

async function abrirFlow() {
  if (!flowToken) return;
  form.hidden = false;
  errorFlow("");
  $("#flow-enviar").disabled = true;
  // INIT: el cliente de WhatsApp pide al endpoint la primera pantalla (contactos y vigencias).
  const r = await api("/api/demo/flow", { flowToken, action: "INIT" });
  if (r.status !== 200) {
    form.hidden = true;
    await bot(`⚠ ${esc(r.respuesta?.error_msg || "No se pudo abrir el formulario")} (HTTP ${r.status})`);
    respuestas([["Cobrar a un contacto", pedirFlow]]);
    return;
  }
  const d = r.respuesta.data;
  campos.contacto.innerHTML = `<option value="">Elige un contacto</option>` +
    d.contactos.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}${c.description ? " · " + esc(c.description) : ""}</option>`).join("");
  $("#f-vigencias").innerHTML = "<legend>Vigencia</legend>" + d.vigencias.map((v, i) =>
    `<label class="radio"><input type="radio" name="vigencia" value="${esc(v.id)}" ${i === 0 ? "checked" : ""}> ${esc(v.title)}</label>`).join("");
  $("#flow-enviar").disabled = false;
  campos.monto.focus();
}

campos.concepto.oninput = () => {
  const n = campos.concepto.value.length;
  $("#f-contador").textContent = `${n}/40`;
  $("#f-contador").classList.toggle("tope", n >= 40);
};
campos.contacto.onchange = () => {
  $("#f-celular-l").hidden = campos.contacto.value !== "otro";
};
$("#flow-cerrar").onclick = () => (form.hidden = true);

form.onsubmit = async (ev) => {
  ev.preventDefault();
  const boton = $("#flow-enviar");
  boton.disabled = true;
  boton.textContent = "Enviando…";
  try {
    const data = {
      monto: campos.monto.value,
      concepto: campos.concepto.value,
      contacto: campos.contacto.value,
      celular: campos.contacto.value === "otro" ? campos.celular.value : "",
      vigencia: form.querySelector("input[name=vigencia]:checked")?.value ?? "",
    };
    // data_exchange: viaja cifrado (RSA-OAEP + AES-GCM) y firmado (X-Hub-Signature-256) al endpoint.
    const r = await api("/api/demo/flow", { flowToken, action: "data_exchange", data });
    if (r.status === 427) {
      form.hidden = true;
      await bot(`⚠ ${esc(r.respuesta?.error_msg || "Este formulario ya no es válido")}`);
      respuestas([["Cobrar a otro contacto", pedirFlow]]);
      return;
    }
    if (r.status !== 200) throw new Error(`endpoint HTTP ${r.status}`);
    if (r.respuesta.screen !== "SUCCESS") {
      errorFlow(r.respuesta.data.error_message, r.respuesta.data.campo_error);
      return;
    }
    form.hidden = true;
    flowToken = null;
    form.reset();
    campos.concepto.oninput();
    $("#f-celular-l").hidden = true;
    const p = r.respuesta.data.extension_message_response.params;
    cobroId = p.cobro_id;
    creados.add(cobroId);
    // El cliente de WhatsApp manda al chat la respuesta del Flow (nfm_reply).
    burbuja("familia nfm", `<b>✓ Cobrar con CoDi</b>${esc(p.contacto)} · ${pesos(p.monto)}<br>${esc(p.concepto)}`);
    const t = r.transporte;
    await bot(
      `📤 Listo. Mandé el cobro CoDi a <b>${esc(p.contacto)}</b> (${esc(p.celular)}):\n` +
      `• ${pesos(p.monto)} · ${esc(p.concepto)}\n• Ref ${esc(p.referencia)} · vale hasta las ${fechaHora(p.expira_en)}\n` +
      `Te aviso aquí en cuanto pague.` +
      `<span class="tecnico">endpoint HTTP ${r.status} · ${esc(t["X-Hub-Signature-256"])} ✓ · RSA-OAEP + AES-GCM ✓ · respuesta cifrada ${esc(t.respuesta_cifrada || "")}</span>`,
    );
    await esperar(800);
    await refrescar();
    mostrarNotificacion();
  } catch (e) {
    errorFlow(e.message);
  } finally {
    boton.disabled = false;
    boton.textContent = "Enviar cobro";
  }
};

// ── Celular del contacto: notificación del banco y app bancaria ──
let estado = null;
const cobroActual = () => estado?.contactos.find((c) => c.id === cobroId);

function mostrarNotificacion() {
  const cc = cobroActual();
  if (!cc) return;
  const c = cc.cobro;
  const benef = config.escuela.razonSocial;
  $("#r-quien").textContent = `Celular de ${cc.familia}`;
  $("#r-vacio").hidden = true;
  $("#r-noti").classList.remove("pospuesta");
  $("#r-noti-titulo").textContent = `Cobro CoDi · ${benef} · ${pesos(c.montoMXN)}`;
  $("#r-noti-txt").textContent = `${c.concepto} · vence ${fechaHora(c.expiraEn)} · toca para pagar`;
  $("#r-noti").hidden = false;
  $("#r-app").hidden = true;
  $("#r-monto").textContent = pesos(c.montoMXN);
  $("#r-benef").textContent = benef;
  $("#r-concepto").textContent = c.concepto;
  $("#r-ref").textContent = c.referencia;
  $("#r-folio").textContent = c.folioCodi || "—";
  $("#r-vig").textContent = "hasta las " + fechaHora(c.expiraEn);
  $("#r-pagar").textContent = `Pagar ${pesos(c.montoMXN)}`;
  $("#r-pagar").hidden = false;
  $("#r-pagar").disabled = false;
  $("#r-listo").hidden = true;
}
const abrirApp = () => {
  $("#r-noti").hidden = true;
  $("#r-app").hidden = false;
};
$("#r-noti-abrir").onclick = abrirApp;
$("#r-aceptar").onclick = abrirApp;
$("#r-posponer").onclick = () => {
  $("#r-noti").classList.add("pospuesta");
  $("#r-noti-txt").textContent = "Pospuesto · tócalo para verlo otra vez";
};
$("#r-rechazar").onclick = async () => {
  const cc = cobroActual();
  $("#r-noti").hidden = true;
  $("#r-vacio").hidden = false;
  $("#r-vacio").textContent = "Rechazaste el cobro. No se te cobró nada.";
  // Pey no manda webhook de rechazo: quien cobra se entera al vencer (la alarma consulta el estado).
  await bot(
    `(Demo) ${esc(cc?.familia ?? "Tu contacto")} rechazó el cobro en su banco. Pey no avisa rechazos: lo sabré al vencer y te lo diré aquí.\n` +
    "Si no tiene CoDi, puedo mandarle un QR o liga de pago por WhatsApp (con una plantilla aprobada).",
  );
  respuestas([["Cobrar a otro contacto", pedirFlow]]);
};
$("#r-pagar").onclick = async () => {
  const b = $("#r-pagar");
  b.disabled = true;
  b.textContent = "Transfiriendo…";
  try {
    // El navegador no marca el pago: el Worker emite el webhook firmado y lo entrega por HTTP a /webhooks/codi.
    const r = await api("/api/demo/aceptar", { cobroContactoId: cobroId });
    if (r.webhook.status !== 200) throw new Error("webhook " + r.webhook.status);
    await refrescar();
  } catch (e) {
    b.disabled = false;
    b.textContent = "Pagar";
    $("#r-listo").hidden = false;
    $("#r-listo").textContent = "⚠ " + e.message;
  }
};

// ── Tablero de cobros + avisos ──
function dibujar(e) {
  estado = e;
  const lista = e.contactos ?? [];
  $("#c-cobros").innerHTML = lista.length
    ? lista.map((c) => {
      const pagado = c.etapa === "pagado";
      const vencido = c.cobro?.estado === "vencido_o_rechazado";
      const detalle = pagado
        ? `✓ pagado · Folio CoDi ${esc(c.pago?.folioCodi || "—")} · comisión $0`
        : c.etapa === "revision" ? "⚠ el pago no coincide · revisión"
        : vencido ? "vencido o rechazado" : `esperando pago · ref ${esc(c.cobro.referencia)} · vence ${fechaHora(c.cobro.expiraEn)}`;
      return `<li class="${pagado ? "pagado" : ""}"><b>${esc(c.familia)}</b> · ${pesos(c.cobro.montoMXN)}` +
        `<div class="detalle">${esc(c.cobro.concepto)} · ${esc(c.cobro.celular || "")}<br>${detalle}</div></li>`;
    }).join("")
    : `<li class="vacio">Aún no mandas cobros. Pídele el formulario al bot.</li>`;
  $("#c-bitacora").innerHTML = e.bitacora.slice(-8).reverse().map((x) =>
    `<li class="${["webhook", "ntfy", "vencimiento", "whatsapp", "cobro"].includes(x.tipo) ? (x.ok ? "ok" : "error") : ""}"><time>${horaSeg(x.en)}</time>${esc(x.texto)}</li>`,
  ).join("") || "<li>Escribe en el chat para empezar.</li>";

  for (const c of lista) {
    if (c.etapa !== "pagado" || avisados.has(c.id)) continue;
    avisados.add(c.id);
    if (creados.has(c.id)) avisarPago(c);
  }
}

async function avisarPago(c) {
  if (c.id === cobroId) {
    $("#r-pagar").hidden = true;
    $("#r-listo").hidden = false;
    $("#r-listo").textContent = `✓ Pago enviado · Folio CoDi ${c.pago?.folioCodi || "—"}`;
  }
  $("#c-respuestas").innerHTML = "";
  await bot(
    `✅ <b>${esc(c.familia)} pagó ${pesos(c.pago.montoMXN)}</b>\n` +
    `Folio CoDi: ${esc(c.pago.folioCodi || "—")}\nRastreo: ${esc(c.pago.claveRastreo || "—")}\n` +
    `Comisión $0 · el dinero ya está en la CLABE de ${esc(config.escuela.razonSocial)}.` +
    `<span class="tecnico">webhook codi.pn.payment_received · firma ✓ · monto y ref ✓ · ntfy enviado</span>`,
  );
  respuestas([["Cobrar a otro contacto", pedirFlow]]);
}

async function refrescar() {
  if ($("#modo-contacto").hidden || !escuela()) return;
  try {
    const e = await api(`/api/tablero?escuela=${encodeURIComponent(escuela())}`);
    dibujar(e);
  } catch {
    /* sin conexión: reintenta en el siguiente ciclo */
  }
}

// ── Arranque ──
if (new URLSearchParams(location.search).get("modo") === "contacto") ponerModo("contacto");
