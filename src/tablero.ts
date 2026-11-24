/**
 * Tablero: un Durable Object por escuela (en la demo, uno por visitante).
 * Guarda los leads del CRM de admisiones y aplica los pagos que llegan por webhook.
 * Un solo hilo por escuela ⇒ la conciliación y la idempotencia no tienen carreras.
 *
 * La alarma del objeto hace dos cosas: revisa los cobros que vencieron sin webhook
 * (consulta al proveedor, ver src/vencimiento.ts) y borra la demo a las 24 h.
 */
import { DurableObject } from "cloudflare:workers";
import { conciliar, type CobroActivo, type CobroContacto, type Etapa, type Lead, type Resultado } from "./conciliacion.ts";
import type { PagoRecibido } from "./pagos/tipos.ts";
import { crearPagos, type EnvPagos } from "./pagos/fabrica.ts";
import { ponerCobroNuevo, proximoVencimiento, revisarVencimiento, type RevisionVencimiento } from "./vencimiento.ts";
import { leadsDeEjemplo } from "./demo.ts";

export interface Evento {
  en: number; // unix ms
  tipo: "crm" | "cobro" | "webhook" | "ntfy" | "vencimiento" | "whatsapp";
  texto: string;
  ok: boolean;
}

export interface EstadoTablero {
  escuela: string;
  leads: Lead[];
  /** Modo «Cobrar a un contacto»: cobros CoDi mandados desde el WhatsApp Flow. */
  contactos: CobroContacto[];
  bitacora: Evento[];
}

interface Guardado extends EstadoTablero {
  webhooks: string[]; // webhook-id ya procesados (idempotencia)
  celulares: Record<string, string>; // leadId → celular (nunca sale al navegador)
  /** flow_token emitido → estado. Un Flow = un cobro: un token usado no vuelve a cobrar. */
  flowTokens: Record<string, "emitido" | "reservado" | "usado">;
  limpiarEn?: number; // unix ms
}

type Lista = "leads" | "contactos";

const VACIO: Guardado = { escuela: "", leads: [], contactos: [], bitacora: [], webhooks: [], celulares: {}, flowTokens: {} };
const DIA_MS = 24 * 3600 * 1000;

export class Tablero extends DurableObject<EnvPagos> {
  private async leer(): Promise<Guardado> {
    const t = (await this.ctx.storage.get<Guardado>("tablero")) ?? structuredClone(VACIO);
    t.contactos ??= []; // tableros guardados antes del modo «Cobrar a un contacto»
    t.flowTokens ??= {};
    return t;
  }

  /** Guarda y programa la alarma: el próximo vencimiento de cobro o la limpieza (24 h sin actividad). */
  private async guardar(t: Guardado, actividad = true): Promise<void> {
    t.bitacora = t.bitacora.slice(-30);
    t.webhooks = t.webhooks.slice(-200);
    t.contactos = t.contactos.slice(-20);
    const tokens = Object.entries(t.flowTokens);
    if (tokens.length > 50) t.flowTokens = Object.fromEntries(tokens.slice(-50));
    if (actividad || !t.limpiarEn) t.limpiarEn = Date.now() + DIA_MS;
    await this.ctx.storage.put("tablero", t);
    const vence = proximoVencimiento([...t.leads, ...t.contactos]);
    let venceMs = vence === undefined ? Infinity : vence * 1000;
    if (venceMs <= Date.now()) venceMs = Date.now() + 60_000; // ya venció y la consulta falló: reintenta en 1 min
    await this.ctx.storage.setAlarm(Math.min(venceMs, t.limpiarEn));
  }

  async alarm(): Promise<void> {
    const t = await this.leer();
    if (!t.escuela || Date.now() >= (t.limpiarEn ?? 0)) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.revisarVencidos(t);
    await this.guardar(t, false);
  }

  /** Revisa los cobros vencidos (o solo el de un lead) y aplica el resultado en t. */
  private async revisarVencidos(t: Guardado, soloLead?: string): Promise<RevisionVencimiento[]> {
    const resultados: RevisionVencimiento[] = [];
    for (const lista of ["leads", "contactos"] as const) resultados.push(...(await this.revisarLista(t, lista, soloLead)));
    return resultados;
  }

  private async revisarLista(t: Guardado, lista: Lista, soloLead?: string): Promise<RevisionVencimiento[]> {
    const pagos = crearPagos(this.env);
    const ahora = Math.floor(Date.now() / 1000);
    const resultados: RevisionVencimiento[] = [];
    const items: Lead[] = t[lista];
    const poner = (nuevos: Lead[]) => {
      if (lista === "leads") t.leads = nuevos;
      else t.contactos = nuevos as CobroContacto[];
    };
    for (const lead of items) {
      if (soloLead && lead.id !== soloLead) continue;
      const r = await revisarVencimiento(lead, pagos, ahora);
      resultados.push(r);
      if (r.tipo === "sin_cambio") continue;
      const c = lead.cobro!;
      const consulta = c.medio === "push" ? "GET /transaction/{id}" : "GET /transaction/codi/qr/{id}";
      if (r.tipo === "vencido") {
        poner(t[lista].map((l: Lead) => (l.id === lead.id ? r.lead : l)));
        t.bitacora.push({
          en: Date.now(),
          tipo: "vencimiento",
          texto: `Cobro ref ${c.referencia} venció sin webhook · ${consulta} → PENDING · vencido o rechazado`,
          ok: false,
        });
      } else if (r.tipo === "pagado_sin_webhook") {
        const { leads, resultado } = conciliar(t[lista], r.pago, Date.now());
        poner(leads);
        t.bitacora.push({
          en: Date.now(),
          tipo: "vencimiento",
          texto: `Cobro ref ${c.referencia} · ${consulta} → PAID sin webhook · ${resultado.tipo}`,
          ok: resultado.tipo === "conciliado",
        });
      } else {
        console.warn("No se pudo consultar el cobro vencido", lead.id, r.error);
        t.bitacora.push({
          en: Date.now(),
          tipo: "vencimiento",
          texto: `No se pudo consultar el cobro ref ${c.referencia}: ${r.error}`,
          ok: false,
        });
      }
    }
    return resultados;
  }

  private publico(t: Guardado): EstadoTablero {
    return { escuela: t.escuela, leads: t.leads, contactos: t.contactos, bitacora: t.bitacora };
  }

  async estado(): Promise<EstadoTablero> {
    return this.publico(await this.leer());
  }

  async iniciar(escuela: string): Promise<EstadoTablero> {
    // Reinicia el tablero de admisiones, pero conserva lo del modo «Cobrar a un contacto»:
    // el Flow puede haberse pedido antes de que la página termine de iniciar la demo.
    const previo = await this.leer();
    const t: Guardado = {
      ...structuredClone(VACIO),
      escuela,
      leads: leadsDeEjemplo(),
      contactos: previo.contactos,
      flowTokens: previo.flowTokens,
      webhooks: previo.webhooks,
      bitacora: previo.bitacora.filter((e) => e.tipo === "whatsapp" || e.tipo === "cobro"),
    };
    await this.guardar(t);
    return this.publico(t);
  }

  async crearLeadDemo(lead: Lead, celular: string, escuela?: string): Promise<Lead> {
    const t = await this.leer();
    if (escuela && !t.escuela) {
      t.escuela = escuela;
      if (!t.leads.length) t.leads = leadsDeEjemplo();
    }
    t.leads = [lead, ...t.leads.filter((l) => l.id !== lead.id)];
    t.celulares[lead.id] = celular;
    t.bitacora.push({ en: Date.now(), tipo: "crm", texto: `Nuevo lead por WhatsApp: ${lead.familia}`, ok: true });
    await this.guardar(t);
    return lead;
  }

  async lead(leadId: string): Promise<{ lead?: Lead; celular?: string; leads: Lead[] }> {
    const t = await this.leer();
    return { lead: t.leads.find((l) => l.id === leadId), celular: t.celulares[leadId], leads: t.leads };
  }

  async moverA(leadId: string, etapa: Etapa): Promise<void> {
    const t = await this.leer();
    t.leads = t.leads.map((l) => (l.id === leadId ? { ...l, etapa } : l));
    await this.guardar(t);
  }

  /** Guarda un cobro NUEVO. El anterior (si había) pasa al historial; nunca se reutiliza. */
  async guardarCobro(leadId: string, cobro: CobroActivo): Promise<void> {
    const t = await this.leer();
    t.leads = t.leads.map((l) => (l.id === leadId ? ponerCobroNuevo(l, cobro) : l));
    const como = cobro.medio === "push" ? `push CoDi a ${cobro.celular}` : "QR CoDi en el chat";
    const min = Math.round((cobro.expiraEn * 1000 - Date.now()) / 60000);
    t.bitacora.push({
      en: Date.now(),
      tipo: "cobro",
      texto: `Mensaje de Cobro nuevo (${como}) · ref ${cobro.referencia} · vence en ${min} min`,
      ok: true,
    });
    await this.guardar(t);
  }

  /**
   * SOLO DEMO: simula que ya pasó la vigencia (adelanta el reloj del cobro) y corre la
   * MISMA revisión que la alarma: consulta al proveedor y marca «vencido o rechazado».
   */
  async vencerAhora(leadId: string): Promise<{ resultado: RevisionVencimiento["tipo"]; lead?: Lead }> {
    const t = await this.leer();
    const ahora = Math.floor(Date.now() / 1000);
    t.leads = t.leads.map((l) =>
      l.id === leadId && l.cobro ? { ...l, cobro: { ...l.cobro, expiraEn: Math.min(l.cobro.expiraEn, ahora) } } : l,
    );
    const [r] = await this.revisarVencidos(t, leadId);
    await this.guardar(t);
    return { resultado: r?.tipo ?? "sin_cambio", lead: t.leads.find((l) => l.id === leadId) };
  }

  /** Aplica un pago verificado. Idempotente por webhook-id y por transacción. */
  async aplicarPago(webhookId: string, pago: PagoRecibido): Promise<{ resultado: Resultado; lead?: Lead }> {
    const t = await this.leer();
    // Los cobros del WhatsApp Flow traen cobroContactoId en los metadatos; los de inscripción, leadId.
    const lista: Lista = pago.metadatos.cobroContactoId ? "contactos" : "leads";
    if (t.webhooks.includes(webhookId)) {
      const lead = (t[lista] as Lead[]).find((l) => l.pago?.transaccionId === pago.transaccionId);
      return { resultado: { tipo: "duplicado", leadId: lead?.id ?? "" }, lead };
    }
    const { leads, resultado } = conciliar(t[lista], pago, Date.now());
    if (lista === "leads") t.leads = leads;
    else t.contactos = leads as CobroContacto[];
    t.webhooks.push(webhookId);
    const evento = pago.medio === "push" ? "codi.pn.payment_received" : "codi.qr.payment_received";
    let texto: string;
    switch (resultado.tipo) {
      case "conciliado":
        texto = `Webhook ${evento} · firma ✓ · monto y ref ✓ · conciliado → ${lista === "leads" ? "Inscrito · Pagado" : "cobro a contacto pagado"}`;
        break;
      case "duplicado":
        texto = `Webhook ${evento} repetido · ignorado`;
        break;
      case "no_coincide": {
        const { recibido: r, esperado: e } = resultado;
        texto = `Webhook ${evento} · firma ✓ · RECHAZADO (${resultado.motivo}): ${r.montoMXN} ref ${r.referencia} ≠ ${e.montoMXN} ref ${e.referencia} → revisión`;
        console.warn("Pago CoDi no coincide con el cobro", JSON.stringify({ webhookId, ...resultado }));
        break;
      }
      default:
        texto = `Webhook ${evento} · sin cobro que coincida`;
        console.warn("Pago CoDi sin cobro", JSON.stringify({ webhookId, referencia: pago.referencia, montoMXN: pago.montoMXN }));
    }
    t.bitacora.push({ en: Date.now(), tipo: "webhook", texto, ok: resultado.tipo === "conciliado" });
    await this.guardar(t);
    const leadId = "leadId" in resultado ? resultado.leadId : undefined;
    return { resultado, lead: (t[lista] as Lead[]).find((l) => l.id === leadId) };
  }

  // ───────── modo «Cobrar a un contacto» (WhatsApp Flow) ─────────

  /** El bot mandó el mensaje de Flow con este flow_token (en producción: Cloud API, type "interactive"/"flow"). */
  async emitirFlowToken(token: string, escuela: string): Promise<void> {
    const t = await this.leer();
    t.escuela ||= escuela; // por si el Flow se pidió antes de iniciar la demo (la alarma borra tableros sin escuela)
    t.flowTokens[token] = "emitido";
    t.bitacora.push({ en: Date.now(), tipo: "whatsapp", texto: `WhatsApp · el bot mandó el Flow «Cobrar con CoDi» (flow_token …${token.slice(-6)})`, ok: true });
    await this.guardar(t);
  }

  /** Aparta el flow_token antes de mandar el push, para que un doble envío del formulario no cobre dos veces. */
  async reservarFlowToken(token: string): Promise<"ok" | "invalido" | "usado"> {
    const t = await this.leer();
    const e = t.flowTokens[token];
    if (!e) return "invalido";
    if (e !== "emitido") return "usado";
    t.flowTokens[token] = "reservado";
    await this.guardar(t);
    return "ok";
  }

  async liberarFlowToken(token: string): Promise<void> {
    const t = await this.leer();
    if (t.flowTokens[token] === "reservado") t.flowTokens[token] = "emitido";
    await this.guardar(t);
  }

  async estadoFlowToken(token: string): Promise<"emitido" | "reservado" | "usado" | undefined> {
    return (await this.leer()).flowTokens[token];
  }

  async guardarCobroContacto(cc: CobroContacto, texto: string): Promise<void> {
    const t = await this.leer();
    t.contactos = [cc, ...t.contactos.filter((c) => c.id !== cc.id)];
    t.flowTokens[cc.flowToken] = "usado";
    t.bitacora.push({ en: Date.now(), tipo: "cobro", texto, ok: true });
    await this.guardar(t);
  }

  async cobroContacto(id: string): Promise<CobroContacto | undefined> {
    return (await this.leer()).contactos.find((c) => c.id === id);
  }

  /** Todas las referencias usadas (leads y contactos): una referencia nunca se repite. */
  async todosLosCobros(): Promise<Lead[]> {
    const t = await this.leer();
    return [...t.leads, ...t.contactos];
  }

  async anotar(evento: Omit<Evento, "en">): Promise<void> {
    const t = await this.leer();
    t.bitacora.push({ en: Date.now(), ...evento });
    await this.guardar(t);
  }
}
