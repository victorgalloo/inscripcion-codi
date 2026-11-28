/**
 * Tablero: un Durable Object por escuela (en la demo, uno por visitante).
 * Guarda los leads del CRM de admisiones y aplica los pagos que llegan por webhook.
 * Un solo hilo por escuela ⇒ la conciliación y la idempotencia no tienen carreras.
 *
 * La alarma del objeto hace dos cosas: revisa los cobros que vencieron sin webhook
 * (consulta al proveedor, ver src/vencimiento.ts) y borra la demo a las 24 h.
 *
 * Agente de cobranza: también lleva la colegiatura del mes de cada familia
 * (src/agenda-cobranza.ts). La alarma corre los pasos de las colegiaturas reales;
 * las de la demo avanzan cuando quien prueba adelanta el reloj.
 *
 * Cuando la conciliación marca un lead como pagado, dispara al agente facturador
 * (src/facturador.ts) y guarda la factura junto al cobro (Lead.factura).
 */
import { DurableObject } from "cloudflare:workers";
import { conciliar, type CobroActivo, type CobroContacto, type Etapa, type Lead, type Resultado } from "./conciliacion.ts";
import type { PagoRecibido } from "./pagos/tipos.ts";
import { crearPagos, type EnvPagos } from "./pagos/fabrica.ts";
import { ponerCobroNuevo, proximoVencimiento, revisarVencimiento, type RevisionVencimiento } from "./vencimiento.ts";
import { VIGENCIA_SEGUNDOS, leadsDeEjemplo, planesDeEjemplo } from "./demo.ts";
import {
  activarCodi,
  avanzar,
  conceptoColegiatura,
  ejecutar,
  marcarPagada,
  nuevaColegiatura,
  proximaAlarmaColegiaturas,
  publica,
  resumen,
  type Colegiatura,
  type EjecutorCobranza,
  type ResumenCobranza,
} from "./agenda-cobranza.ts";
import { validarPoliticaCobro } from "./pagos/tipos.ts";
import { nuevaReferencia } from "./conciliacion.ts";
import { pesos } from "./mensajes.ts";
import type { EnvModo } from "./modo.ts";
import { configFacturador, crearFacturacion } from "./facturacion/fabrica.ts";
import type {
  ComplementoIEDU,
  DatosFiscales,
  EnvFacturacion,
  EventoFactura,
  RegistroFactura,
  SolicitudCancelacion,
} from "./facturacion/tipos.ts";
import {
  aplicarEventoFactura,
  buscarFactura,
  cancelarFactura,
  facturarLead,
  sustituirConDatosFiscales,
  type ContextoFacturador,
  type ResultadoFacturador,
} from "./facturador.ts";
import type { AlmacenFacturas } from "./facturas.ts";

export interface Evento {
  en: number; // unix ms
  tipo: "crm" | "cobro" | "webhook" | "ntfy" | "vencimiento" | "whatsapp" | "factura";
  texto: string;
  ok: boolean;
}

export interface EstadoTablero {
  escuela: string;
  leads: Lead[];
  /** Modo «Cobrar a un contacto»: cobros CoDi mandados desde el WhatsApp Flow. */
  contactos: CobroContacto[];
  bitacora: Evento[];
  /** Agente de cobranza: colegiaturas del mes (celular enmascarado). */
  colegiaturas: Colegiatura[];
  cobranza: ResumenCobranza;
}

interface Guardado extends Omit<EstadoTablero, "cobranza"> {
  webhooks: string[]; // webhook-id ya procesados (idempotencia)
  celulares: Record<string, string>; // leadId → celular (nunca sale al navegador)
  /** flow_token emitido → estado. Un Flow = un cobro: un token usado no vuelve a cobrar. */
  flowTokens: Record<string, "emitido" | "reservado" | "usado">;
  limpiarEn?: number; // unix ms
}

type Lista = "leads" | "contactos";

const VACIO: Guardado = { escuela: "", leads: [], contactos: [], bitacora: [], colegiaturas: [], webhooks: [], celulares: {}, flowTokens: {} };
const DIA_MS = 24 * 3600 * 1000;

export class Tablero extends DurableObject<EnvPagos & EnvFacturacion & EnvModo> implements AlmacenFacturas {
  /** Leads que la revisión de vencimiento encontró pagados: se facturan tras guardar. */
  private porFacturar: string[] = [];

  private async leer(): Promise<Guardado> {
    const t = (await this.ctx.storage.get<Guardado>("tablero")) ?? structuredClone(VACIO);
    t.contactos ??= []; // tableros guardados antes del modo «Cobrar a un contacto»
    t.flowTokens ??= {};
    t.colegiaturas ??= [];
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
    const paso = proximaAlarmaColegiaturas(t.colegiaturas, Math.floor(Date.now() / 1000));
    const siguiente = Math.min(vence ?? Infinity, paso ?? Infinity);
    let venceMs = siguiente === Infinity ? Infinity : siguiente * 1000;
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
    await this.correrColegiaturas(t);
    await this.guardar(t, false);
    await this.facturarPorFacturar();
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
        if (resultado.tipo === "conciliado" && lista === "leads") this.porFacturar.push(resultado.leadId);
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
    return {
      escuela: t.escuela,
      leads: t.leads,
      contactos: t.contactos,
      bitacora: t.bitacora,
      colegiaturas: t.colegiaturas.map(publica),
      cobranza: resumen(t.colegiaturas),
    };
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
    let t = await this.leer();
    const ahora = Math.floor(Date.now() / 1000);
    t.leads = t.leads.map((l) =>
      l.id === leadId && l.cobro ? { ...l, cobro: { ...l.cobro, expiraEn: Math.min(l.cobro.expiraEn, ahora) } } : l,
    );
    const [r] = await this.revisarVencidos(t, leadId);
    await this.guardar(t);
    if (await this.facturarPorFacturar()) t = await this.leer();
    return { resultado: r?.tipo ?? "sin_cambio", lead: t.leads.find((l) => l.id === leadId) };
  }

  /**
   * Aplica un pago verificado. Idempotente por webhook-id y por transacción.
   * Si quedó conciliado, el agente facturador timbra la factura (un pago = una factura).
   */
  async aplicarPago(
    webhookId: string,
    pago: PagoRecibido,
  ): Promise<{ resultado: Resultado; lead?: Lead; factura?: ResultadoFacturador }> {
    if (pago.metadatos.colegiaturaId) return this.aplicarPagoColegiatura(webhookId, pago);
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
    // Se guarda el pago ANTES de facturar: el cobro nunca depende de la factura.
    await this.guardar(t);
    const leadId = "leadId" in resultado ? resultado.leadId : undefined;
    let factura: ResultadoFacturador | undefined;
    let final = t;
    if (resultado.tipo === "conciliado" && lista === "leads") {
      factura = await this.facturarSinRomper(resultado.leadId);
      final = await this.leer();
    }
    return { resultado, lead: (final[lista] as Lead[]).find((l) => l.id === leadId), ...(factura ? { factura } : {}) };
  }

  // ───────── agente de cobranza (colegiatura del mes) ─────────

  /** Ejecutor del agente: cada paso que cobra manda un push CoDi NUEVO al celular de la familia. */
  private ejecutorCobranza(t: Guardado): EjecutorCobranza {
    return {
      cobrar: async (c, paso, montoMXN) => {
        // Con pey real el monto y el celular salen de la configuración de prueba ($0.01, celular de Victor):
        // eso se conecta cuando haya un colegio real. Hoy el agente de cobranza corre en mock.
        if (this.env.PAGOS_PROVEEDOR !== "mock") throw new Error("el agente de cobranza corre solo en modo mock por ahora");
        const referencia = nuevaReferencia(
          [...t.leads, ...t.contactos],
          Math.random,
          t.colegiaturas.flatMap((x) => x.cobros.map((k) => k.referencia)),
        );
        const concepto = conceptoColegiatura(c);
        const solicitud = {
          montoMXN,
          concepto,
          referencia,
          vigenciaSegundos: VIGENCIA_SEGUNDOS,
          metadatos: { escuelaId: t.escuela, colegiaturaId: c.id },
        };
        validarPoliticaCobro(solicitud, { montoConfirmadoMXN: montoMXN, datosPrivados: [c.plan.alumno] });
        const cobro = await crearPagos(this.env).crearCobroPush(c.plan.celular, solicitud);
        t.bitacora.push({
          en: Date.now(),
          tipo: "cobro",
          texto: `Agente de cobranza · ${paso.tipo} · push CoDi nuevo a ${cobro.celular} · ${pesos(montoMXN)} · ref ${referencia}`,
          ok: true,
        });
        return { referencia, id: cobro.transaccionId, concepto };
      },
    };
  }

  /** Alarma: corre el paso que toque de cada colegiatura real (las de demo no se mueven solas). */
  private async correrColegiaturas(t: Guardado): Promise<void> {
    const ahora = Math.floor(Date.now() / 1000);
    for (const [i, c] of t.colegiaturas.entries()) {
      if (c.demo || c.pagada) continue;
      try {
        const r = await ejecutar(c, ahora, this.ejecutorCobranza(t));
        t.colegiaturas[i] = r.colegiatura;
        if (r.paso) this.anotarPaso(t, r.colegiatura, r.paso.tipo);
      } catch (e) {
        t.bitacora.push({ en: Date.now(), tipo: "cobro", texto: `Agente de cobranza · error: ${(e as Error).message}`, ok: false });
      }
    }
  }

  private anotarPaso(t: Guardado, c: Colegiatura, tipo: string): void {
    const m = c.mensajes.at(-1);
    const quien = c.plan.alumno;
    t.bitacora.push({
      en: Date.now(),
      tipo: tipo === "escalar_colegio" ? "crm" : "whatsapp",
      texto:
        tipo === "escalar_colegio"
          ? `Agente de cobranza · ${quien}: sin pago tras 4 cobros CoDi → pasa al colegio`
          : `WhatsApp a la familia de ${quien} (${tipo}): ${m?.texto ?? ""}`,
      ok: tipo !== "escalar_colegio",
    });
  }

  /** Demo: carga las familias ficticias con la colegiatura del mes siguiente. */
  async iniciarColegiaturas(anio: number, mes: number): Promise<EstadoTablero> {
    const t = await this.leer();
    t.colegiaturas = planesDeEjemplo().map((p) => ({ ...nuevaColegiatura(p, anio, mes), demo: true }));
    t.bitacora.push({ en: Date.now(), tipo: "crm", texto: `Agente de cobranza · ${t.colegiaturas.length} colegiaturas de ${mes}/${anio} en agenda`, ok: true });
    await this.guardar(t);
    return this.publico(t);
  }

  /** Demo: adelanta el reloj de una colegiatura a su siguiente paso y lo ejecuta. */
  async avanzarColegiatura(id: string): Promise<{ colegiatura?: Colegiatura; paso?: string }> {
    const t = await this.leer();
    const i = t.colegiaturas.findIndex((c) => c.id === id);
    if (i < 0) return {};
    const r = await avanzar(t.colegiaturas[i]!, this.ejecutorCobranza(t));
    t.colegiaturas[i] = r.colegiatura;
    if (r.paso) this.anotarPaso(t, r.colegiatura, r.paso.tipo);
    await this.guardar(t);
    return { colegiatura: publica(r.colegiatura), paso: r.paso?.tipo };
  }

  /** La familia activó CoDi con la guía del agente de adopción. */
  async activarCodiColegiatura(id: string): Promise<Colegiatura | undefined> {
    const t = await this.leer();
    const i = t.colegiaturas.findIndex((c) => c.id === id);
    if (i < 0) return undefined;
    t.colegiaturas[i] = activarCodi(t.colegiaturas[i]!);
    t.bitacora.push({ en: Date.now(), tipo: "crm", texto: `Agente de adopción · la familia de ${t.colegiaturas[i]!.plan.alumno} ya tiene CoDi`, ok: true });
    await this.guardar(t);
    return publica(t.colegiaturas[i]!);
  }

  /** Demo: el último cobro de la colegiatura (para simular que la familia lo acepta). */
  async ultimoCobroColegiatura(id: string) {
    const c = (await this.leer()).colegiaturas.find((x) => x.id === id);
    return c ? { pagada: c.pagada, cobro: c.cobros.at(-1) } : undefined;
  }

  private async aplicarPagoColegiatura(webhookId: string, pago: PagoRecibido): Promise<{ resultado: Resultado }> {
    const t = await this.leer();
    const id = pago.metadatos.colegiaturaId!;
    if (t.webhooks.includes(webhookId)) return { resultado: { tipo: "duplicado", leadId: id } };
    const i = t.colegiaturas.findIndex((c) => c.id === id);
    const evento = pago.medio === "push" ? "codi.pn.payment_received" : "codi.qr.payment_received";
    if (i < 0) {
      t.bitacora.push({ en: Date.now(), tipo: "webhook", texto: `Webhook ${evento} · colegiatura desconocida`, ok: false });
      await this.guardar(t);
      return { resultado: { tipo: "sin_cobro" } };
    }
    const r = marcarPagada(t.colegiaturas[i]!, pago.referencia, pago.montoMXN, pago.pagadoEn);
    t.webhooks.push(webhookId);
    if (r.tipo === "no_coincide") {
      t.bitacora.push({ en: Date.now(), tipo: "webhook", texto: `Webhook ${evento} · firma ✓ · colegiatura RECHAZADO (${r.motivo}) → revisión`, ok: false });
      await this.guardar(t);
      const esperado = t.colegiaturas[i]!.cobros.at(-1);
      return {
        resultado: {
          tipo: "no_coincide",
          leadId: id,
          motivo: r.motivo,
          esperado: { montoMXN: esperado?.montoMXN ?? 0, referencia: esperado?.referencia ?? "" },
          recibido: { montoMXN: pago.montoMXN, referencia: pago.referencia },
        },
      };
    }
    t.colegiaturas[i] = r.colegiatura;
    if (r.tipo === "conciliado") {
      t.bitacora.push({
        en: Date.now(),
        tipo: "webhook",
        texto: `Webhook ${evento} · firma ✓ · colegiatura de ${r.colegiatura.plan.alumno} pagada (${pesos(pago.montoMXN)}, ${r.colegiatura.pagadaCon}) · el agente deja de cobrar`,
        ok: true,
      });
    }
    await this.guardar(t);
    return { resultado: { tipo: r.tipo, leadId: id } };
  }

  // ───────── agente facturador ─────────

  /** El agente facturador sobre el storage de este objeto. */
  private async contextoFacturador(): Promise<ContextoFacturador> {
    const t = await this.leer();
    return {
      repo: {
        leads: async () => (await this.leer()).leads,
        guardarRegistro: async (leadId: string, registro: RegistroFactura) => {
          const u = await this.leer();
          u.leads = u.leads.map((l) => (l.id === leadId ? { ...l, factura: registro } : l));
          await this.guardar(u);
        },
        anotar: async (texto: string, ok: boolean) => {
          const u = await this.leer();
          u.bitacora.push({ en: Date.now(), tipo: "factura", texto, ok });
          await this.guardar(u);
        },
      },
      facturacion: crearFacturacion(this.env),
      config: configFacturador(this.env),
      escuelaId: t.escuela,
    };
  }

  /** Factura tras conciliar. Un error de configuración o del proveedor NUNCA revierte el cobro. */
  private async facturarSinRomper(leadId: string): Promise<ResultadoFacturador | undefined> {
    try {
      return await facturarLead(await this.contextoFacturador(), leadId);
    } catch (e) {
      console.warn("No se pudo facturar el pago", leadId, (e as Error).message);
      await this.anotar({ tipo: "factura", texto: `No se pudo facturar: ${(e as Error).message}`, ok: false });
      return undefined;
    }
  }

  private async facturarPorFacturar(): Promise<boolean> {
    const ids = this.porFacturar.splice(0);
    for (const id of ids) await this.facturarSinRomper(id);
    return ids.length > 0;
  }

  async facturar(
    leadId: string,
    opciones: { datosFiscales?: DatosFiscales; iedu?: ComplementoIEDU; reintentar?: boolean } = {},
  ) {
    return facturarLead(await this.contextoFacturador(), leadId, opciones);
  }

  async sustituirFactura(leadId: string, datos: DatosFiscales, iedu?: ComplementoIEDU) {
    return sustituirConDatosFiscales(await this.contextoFacturador(), leadId, datos, iedu);
  }

  async cancelarFactura(id: string, c: SolicitudCancelacion) {
    return cancelarFactura(await this.contextoFacturador(), id, c);
  }

  async factura(id: string) {
    const h = buscarFactura((await this.leer()).leads, id);
    return h ? { leadId: h.lead.id, factura: h.factura, registro: h.lead.factura! } : undefined;
  }

  /** Webhook del proveedor de facturación. Idempotente por webhook-id. */
  async eventoFactura(webhookId: string, evento: EventoFactura) {
    const t = await this.leer();
    if (t.webhooks.includes(webhookId)) return { tipo: "duplicado" as const };
    t.webhooks.push(webhookId);
    await this.guardar(t);
    return aplicarEventoFactura((await this.contextoFacturador()).repo, evento);
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
