/**
 * Vencimiento de Mensajes de Cobro.
 *
 * Pey solo manda webhook cuando el cobro se PAGA (codi.pn.payment_received /
 * codi.qr.payment_received); no avisa si la familia lo rechaza, lo pospone o lo
 * deja vencer. Por eso, al llegar la vigencia sin webhook, consultamos al proveedor:
 *   - PAGADO    → se perdió el webhook: se concilia con lo que reporta el proveedor.
 *   - PENDIENTE → el cobro queda «vencido o rechazado» y el agente ofrece uno NUEVO
 *                 (folio y referencia nuevos) o el QR. Nunca se reutiliza el vencido.
 *
 * Lógica pura (sin storage): la usa el Durable Object desde su alarma.
 */
import type { CobroActivo, Lead } from "./conciliacion.ts";
import type { PagoRecibido, PagosCoDi } from "./pagos/tipos.ts";

export type RevisionVencimiento =
  | { tipo: "sin_cambio" }
  | { tipo: "vencido"; lead: Lead }
  | { tipo: "pagado_sin_webhook"; pago: PagoRecibido }
  | { tipo: "error"; error: string };

export function estaVigente(c: CobroActivo | undefined): c is CobroActivo {
  return Boolean(c) && (c!.estado ?? "vigente") === "vigente";
}

/** Unix (s) del próximo vencimiento pendiente de revisar, si hay. */
export function proximoVencimiento(leads: Lead[]): number | undefined {
  const fechas = leads
    .filter((l) => l.etapa !== "pagado" && estaVigente(l.cobro))
    .map((l) => l.cobro!.expiraEn);
  return fechas.length ? Math.min(...fechas) : undefined;
}

export async function revisarVencimiento(
  lead: Lead,
  pagos: Pick<PagosCoDi, "estadoCobro">,
  ahora: number,
): Promise<RevisionVencimiento> {
  const c = lead.cobro;
  if (!estaVigente(c) || lead.etapa === "pagado" || ahora < c.expiraEn) return { tipo: "sin_cambio" };
  let e;
  try {
    e = await pagos.estadoCobro({ medio: c.medio, id: c.id });
  } catch (err) {
    return { tipo: "error", error: (err as Error).message };
  }
  if (e.estado === "PAGADO") {
    return {
      tipo: "pagado_sin_webhook",
      pago: {
        medio: c.medio,
        transaccionId: e.transaccionId ?? c.id,
        cobroId: c.medio === "qr" ? c.id : undefined,
        // Si el proveedor no reporta monto, NaN hace que la conciliación lo mande a revisión.
        montoMXN: e.montoMXN ?? Number.NaN,
        referencia: c.referencia,
        concepto: c.concepto,
        pagadoEn: e.pagadoEn ?? ahora,
        claveRastreo: e.claveRastreo,
        metadatos: { leadId: lead.id },
      },
    };
  }
  return { tipo: "vencido", lead: { ...lead, cobro: { ...c, estado: "vencido_o_rechazado" } } };
}

/**
 * Pone un cobro NUEVO en el lead. El anterior pasa al historial: si seguía
 * vigente queda «sustituido» (un pago tardío de ese cobro no coincidirá en
 * referencia y se irá a revisión, no a «pagado»).
 */
export function ponerCobroNuevo(lead: Lead, nuevo: CobroActivo): Lead {
  const anteriores = [...(lead.cobrosAnteriores ?? [])];
  if (lead.cobro) {
    anteriores.push(estaVigente(lead.cobro) ? { ...lead.cobro, estado: "sustituido" } : lead.cobro);
  }
  return {
    ...lead,
    etapa: "cobro_enviado",
    cobro: { ...nuevo, estado: "vigente" },
    cobrosAnteriores: anteriores.slice(-10),
    nota: undefined,
  };
}
