/**
 * Tablero: un Durable Object por escuela (en la demo, uno por visitante).
 * Guarda los leads del CRM de admisiones y aplica los pagos que llegan por webhook.
 * Un solo hilo por escuela ⇒ la conciliación y la idempotencia no tienen carreras.
 */
import { DurableObject } from "cloudflare:workers";
import { conciliar, type CobroActivo, type Etapa, type Lead, type Resultado } from "./conciliacion.ts";
import type { PagoRecibido } from "./pagos/tipos.ts";
import { leadsDeEjemplo } from "./demo.ts";

export interface Evento {
  en: number; // unix ms
  tipo: "crm" | "cobro" | "webhook" | "ntfy";
  texto: string;
  ok: boolean;
}

export interface EstadoTablero {
  escuela: string;
  leads: Lead[];
  bitacora: Evento[];
}

interface Guardado extends EstadoTablero {
  webhooks: string[]; // webhook-id ya procesados (idempotencia)
  celulares: Record<string, string>; // leadId → celular (nunca sale al navegador)
}

const VACIO: Guardado = { escuela: "", leads: [], bitacora: [], webhooks: [], celulares: {} };

export class Tablero extends DurableObject {
  private async leer(): Promise<Guardado> {
    return (await this.ctx.storage.get<Guardado>("tablero")) ?? structuredClone(VACIO);
  }

  private async guardar(t: Guardado): Promise<void> {
    t.bitacora = t.bitacora.slice(-30);
    t.webhooks = t.webhooks.slice(-200);
    await this.ctx.storage.put("tablero", t);
    // La demo se limpia sola a las 24 h.
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private publico(t: Guardado): EstadoTablero {
    return { escuela: t.escuela, leads: t.leads, bitacora: t.bitacora };
  }

  async estado(): Promise<EstadoTablero> {
    return this.publico(await this.leer());
  }

  async iniciar(escuela: string): Promise<EstadoTablero> {
    const t: Guardado = { ...structuredClone(VACIO), escuela, leads: leadsDeEjemplo() };
    await this.guardar(t);
    return this.publico(t);
  }

  async crearLeadDemo(lead: Lead, celular: string): Promise<Lead> {
    const t = await this.leer();
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

  async guardarCobro(leadId: string, cobro: CobroActivo): Promise<void> {
    const t = await this.leer();
    t.leads = t.leads.map((l) => (l.id === leadId ? { ...l, etapa: "cobro_enviado", cobro } : l));
    const como = cobro.medio === "push" ? `push CoDi a ${cobro.celular}` : "QR CoDi en el chat";
    t.bitacora.push({
      en: Date.now(),
      tipo: "cobro",
      texto: `Mensaje de Cobro (${como}) · ref ${cobro.referencia}`,
      ok: true,
    });
    await this.guardar(t);
  }

  /** Aplica un pago verificado. Idempotente por webhook-id y por transacción. */
  async aplicarPago(webhookId: string, pago: PagoRecibido): Promise<{ resultado: Resultado; lead?: Lead }> {
    const t = await this.leer();
    if (t.webhooks.includes(webhookId)) {
      const lead = t.leads.find((l) => l.pago?.transaccionId === pago.transaccionId);
      return { resultado: { tipo: "duplicado", leadId: lead?.id ?? "" }, lead };
    }
    const { leads, resultado } = conciliar(t.leads, pago, Date.now());
    t.leads = leads;
    t.webhooks.push(webhookId);
    const evento =
      pago.medio === "push" ? "codi.pn.payment_received" : "codi.qr.payment_received";
    const texto: Record<Resultado["tipo"], string> = {
      conciliado: `Webhook ${evento} · firma ✓ · conciliado → Inscrito · Pagado`,
      duplicado: `Webhook ${evento} repetido · ignorado`,
      monto_distinto: `Webhook ${evento} · monto distinto → revisión`,
      sin_cobro: `Webhook ${evento} · sin cobro que coincida`,
    };
    t.bitacora.push({ en: Date.now(), tipo: "webhook", texto: texto[resultado.tipo], ok: resultado.tipo === "conciliado" });
    await this.guardar(t);
    const leadId = "leadId" in resultado ? resultado.leadId : undefined;
    return { resultado, lead: t.leads.find((l) => l.id === leadId) };
  }

  async anotar(evento: Omit<Evento, "en">): Promise<void> {
    const t = await this.leer();
    t.bitacora.push({ en: Date.now(), ...evento });
    await this.guardar(t);
  }
}
