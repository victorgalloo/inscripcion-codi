/**
 * Tablero: un Durable Object por escuela (en la demo, uno por visitante).
 * Guarda los leads del CRM de admisiones y aplica los pagos que llegan por webhook.
 * Un solo hilo por escuela ⇒ la conciliación y la idempotencia no tienen carreras.
 *
 * La alarma del objeto hace dos cosas: revisa los cobros que vencieron sin webhook
 * (consulta al proveedor, ver src/vencimiento.ts) y borra la demo a las 24 h.
 */
import { DurableObject } from "cloudflare:workers";
import { conciliar, type CobroActivo, type Etapa, type Lead, type Resultado } from "./conciliacion.ts";
import type { PagoRecibido } from "./pagos/tipos.ts";
import { crearPagos, type EnvPagos } from "./pagos/fabrica.ts";
import { ponerCobroNuevo, proximoVencimiento, revisarVencimiento, type RevisionVencimiento } from "./vencimiento.ts";
import { leadsDeEjemplo } from "./demo.ts";

export interface Evento {
  en: number; // unix ms
  tipo: "crm" | "cobro" | "webhook" | "ntfy" | "vencimiento";
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
  limpiarEn?: number; // unix ms
}

const VACIO: Guardado = { escuela: "", leads: [], bitacora: [], webhooks: [], celulares: {} };
const DIA_MS = 24 * 3600 * 1000;

export class Tablero extends DurableObject<EnvPagos> {
  private async leer(): Promise<Guardado> {
    return (await this.ctx.storage.get<Guardado>("tablero")) ?? structuredClone(VACIO);
  }

  /** Guarda y programa la alarma: el próximo vencimiento de cobro o la limpieza (24 h sin actividad). */
  private async guardar(t: Guardado, actividad = true): Promise<void> {
    t.bitacora = t.bitacora.slice(-30);
    t.webhooks = t.webhooks.slice(-200);
    if (actividad || !t.limpiarEn) t.limpiarEn = Date.now() + DIA_MS;
    await this.ctx.storage.put("tablero", t);
    const vence = proximoVencimiento(t.leads);
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
    const pagos = crearPagos(this.env);
    const ahora = Math.floor(Date.now() / 1000);
    const resultados: RevisionVencimiento[] = [];
    for (const lead of t.leads) {
      if (soloLead && lead.id !== soloLead) continue;
      const r = await revisarVencimiento(lead, pagos, ahora);
      resultados.push(r);
      if (r.tipo === "sin_cambio") continue;
      const c = lead.cobro!;
      const consulta = c.medio === "push" ? "GET /transaction/{id}" : "GET /transaction/codi/qr/{id}";
      if (r.tipo === "vencido") {
        t.leads = t.leads.map((l) => (l.id === lead.id ? r.lead : l));
        t.bitacora.push({
          en: Date.now(),
          tipo: "vencimiento",
          texto: `Cobro ref ${c.referencia} venció sin webhook · ${consulta} → PENDING · vencido o rechazado`,
          ok: false,
        });
      } else if (r.tipo === "pagado_sin_webhook") {
        const { leads, resultado } = conciliar(t.leads, r.pago, Date.now());
        t.leads = leads;
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
    if (t.webhooks.includes(webhookId)) {
      const lead = t.leads.find((l) => l.pago?.transaccionId === pago.transaccionId);
      return { resultado: { tipo: "duplicado", leadId: lead?.id ?? "" }, lead };
    }
    const { leads, resultado } = conciliar(t.leads, pago, Date.now());
    t.leads = leads;
    t.webhooks.push(webhookId);
    const evento = pago.medio === "push" ? "codi.pn.payment_received" : "codi.qr.payment_received";
    let texto: string;
    switch (resultado.tipo) {
      case "conciliado":
        texto = `Webhook ${evento} · firma ✓ · monto y ref ✓ · conciliado → Inscrito · Pagado`;
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
    return { resultado, lead: t.leads.find((l) => l.id === leadId) };
  }

  async anotar(evento: Omit<Evento, "en">): Promise<void> {
    const t = await this.leer();
    t.bitacora.push({ en: Date.now(), ...evento });
    await this.guardar(t);
  }
}
