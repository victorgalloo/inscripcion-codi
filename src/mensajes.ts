/**
 * Lo que el agente le dice a la familia por WhatsApp alrededor del cobro CoDi.
 *
 * Antes del push: nombre EXACTO del beneficiario (la razón social que verá en su
 * banco), monto, concepto, referencia, hasta qué hora vale y «sin comisión». Así
 * la familia reconoce el cobro y no lo reporta como desconocido (Reglas del SPEI,
 * regla 9a. Bis, fracc. V, incisos c y h). Ver docs/regulacion.md.
 */

export const ZONA_HORARIA = "America/Mexico_City";

export const AVISO_PRIVACIDAD =
  "Aviso de privacidad (demo): usamos el celular de este chat solo para enviarte el cobro CoDi " +
  "y lo compartimos con el proveedor de pagos (Pey) para ese fin.";

export const pesos = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 });

/** «14/11/2026 15:30» en la hora del centro de México. */
export function fechaHora(unixSeg: number, zona = ZONA_HORARIA): string {
  const partes = new Intl.DateTimeFormat("es-MX", {
    timeZone: zona,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(unixSeg * 1000));
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export interface DatosCobroMensaje {
  medio: "push" | "qr";
  montoMXN: number;
  concepto: string;
  referencia: string;
  expiraEn: number;
  celular?: string; // enmascarado
}

/** Mensaje (texto plano, con saltos de línea) que se manda ANTES de que llegue el push o junto al QR. */
export function mensajeAntesDelCobro(c: DatosCobroMensaje, razonSocial: string, zona = ZONA_HORARIA): string {
  const intro =
    c.medio === "push"
      ? `Te envío una solicitud de cobro CoDi a la app de tu banco${c.celular ? ` (celular ${c.celular})` : ""}. Revisa que diga:`
      : "Escanea este QR CoDi desde la app de tu banco. Revisa que diga:";
  const cierre =
    c.medio === "push"
      ? "Ábrela y toca Aceptar. También puedes Rechazarla o Posponerla. Si no te llega, te mando un QR o una liga de pago."
      : "Si no puedes escanearlo, te mando una liga de pago.";
  return [
    intro,
    `• Beneficiario: ${razonSocial}`,
    `• Monto: ${pesos(c.montoMXN)}, sin comisión`,
    `• Concepto: ${c.concepto}`,
    `• Referencia: ${c.referencia}`,
    `• Vale hasta: ${fechaHora(c.expiraEn, zona)} (hora del centro)`,
    cierre,
  ].join("\n");
}
