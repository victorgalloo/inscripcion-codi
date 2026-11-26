/**
 * FacturacionMock — timbrado SIMULADO para la demo pública.
 *
 * ⚠️  No habla con ningún proveedor ni con el SAT. Devuelve facturas con la MISMA forma
 * que la respuesta canónica (src/facturacion/tipos.ts), con un UUID de forma real, y
 * arma un PDF y un XML de muestra marcados «SIMULADO, sin validez fiscal». Así el
 * agente facturador, el tablero y las rutas corren el mismo código que en producción.
 * Cambiar a un proveedor real = FACTURACION_PROVEEDOR="http" (o una clase nueva).
 */
import type { Facturacion, Factura, SolicitudCancelacion, SolicitudFactura } from "./tipos.ts";
import { validarCancelacion } from "./tipos.ts";
import { OFFSET_CDMX_SEG } from "../cobranza.ts";

export const LEYENDA_SIMULADO = "SIMULADO, sin validez fiscal";

export class FacturacionMock implements Facturacion {
  readonly proveedor = "mock" as const;
  private ahora: () => number;
  private uuid: () => string;
  /** Emitidas en esta instancia (para consultar/cancelar e idempotencia en pruebas). */
  private emitidas = new Map<string, Factura>();

  constructor(opciones: { ahora?: () => number; uuid?: () => string } = {}) {
    this.ahora = opciones.ahora ?? (() => Math.floor(Date.now() / 1000));
    this.uuid = opciones.uuid ?? (() => crypto.randomUUID().toUpperCase());
  }

  async emitir(s: SolicitudFactura): Promise<Factura> {
    const previa = [...this.emitidas.values()].find((f) => f.llave === s.llave);
    if (previa) return structuredClone(previa); // idempotente por llave, como se le pide a un proveedor real
    const id = "fac_demo_" + this.uuid().slice(0, 8).toLowerCase();
    const f: Factura = {
      proveedor: "mock",
      id,
      llave: s.llave,
      uuid: this.uuid(),
      estado: "timbrada",
      emisor: { rfc: s.emisor.rfc, nombre: s.emisor.nombre },
      receptor: { rfc: s.receptor.rfc, nombre: s.receptor.nombre, usoCfdi: s.receptor.usoCfdi },
      publicoEnGeneral: s.publicoEnGeneral,
      // Sin el complemento IEDU: el nombre y la CURP del alumno no se guardan.
      conceptos: s.conceptos.map((c) => ({ claveProdServ: c.claveProdServ, descripcion: c.descripcion, importe: c.importe })),
      subtotal: s.subtotal,
      total: s.total,
      moneda: "MXN",
      formaPago: s.formaPago,
      metodoPago: s.metodoPago,
      // Ligas internas: las sirve este mismo Worker (GET /api/facturas/:id/pdf y /xml).
      pdfUrl: `/api/facturas/${id}/pdf`,
      xmlUrl: `/api/facturas/${id}/xml`,
      emitidaEn: this.ahora(),
      metadatos: { ...s.metadatos },
    };
    this.emitidas.set(id, f);
    return structuredClone(f);
  }

  async consultar(id: string): Promise<Factura> {
    const f = this.emitidas.get(id);
    if (!f) throw new Error("Factura no encontrada (mock)");
    return structuredClone(f);
  }

  async cancelar(id: string, c: SolicitudCancelacion): Promise<Factura> {
    validarCancelacion(c);
    const f = this.emitidas.get(id);
    // Cada request del Worker crea su propia instancia: si no la conoce, la cancelación igual procede.
    const base: Factura = f ?? ({ id, estado: "timbrada" } as Factura);
    const cancelada: Factura = {
      ...base,
      estado: "cancelada",
      canceladaEn: this.ahora(),
      motivoCancelacion: c.motivo,
      ...(c.folioSustitucion ? { sustituidaPor: c.folioSustitucion } : {}),
    };
    if (f) this.emitidas.set(id, cancelada);
    return structuredClone(cancelada);
  }

  async archivo(f: Factura, formato: "pdf" | "xml") {
    return formato === "pdf"
      ? { tipo: "application/pdf", cuerpo: pdfDeMuestra(f) }
      : { tipo: "application/xml; charset=utf-8", cuerpo: xmlDeMuestra(f) };
  }
}

const xmlEsc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Fecha del CFDI: hora local del lugar de expedición (centro de México), sin zona. */
const fechaIso = (unix: number) => new Date((unix + OFFSET_CDMX_SEG) * 1000).toISOString().slice(0, 19);
const dinero = (n: number) => n.toFixed(2);

/** XML con la forma de un CFDI 4.0 timbrado. SIN sello ni certificado: no es un CFDI válido. */
export function xmlDeMuestra(f: Factura): string {
  const conceptos = f.conceptos
    .map(
      (c) =>
        `    <cfdi:Concepto ClaveProdServ="${xmlEsc(c.claveProdServ)}" Cantidad="1" ClaveUnidad="E48" Descripcion="${xmlEsc(c.descripcion)}" ValorUnitario="${dinero(c.importe)}" Importe="${dinero(c.importe)}" ObjetoImp="02">\n` +
        `      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${dinero(c.importe)}" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos>\n` +
        `    </cfdi:Concepto>`,
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${LEYENDA_SIMULADO}. Muestra generada por la demo de Inscrito: sin sello, sin certificado y sin timbre del SAT. -->`,
    `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Fecha="${fechaIso(f.emitidaEn)}" FormaPago="${xmlEsc(f.formaPago)}" SubTotal="${dinero(f.subtotal)}" Moneda="MXN" Total="${dinero(f.total)}" TipoDeComprobante="I" Exportacion="01" MetodoPago="${f.metodoPago}" Sello="${LEYENDA_SIMULADO}" Certificado="" NoCertificado="00000000000000000000">`,
    `  <cfdi:Emisor Rfc="${xmlEsc(f.emisor.rfc)}" Nombre="${xmlEsc(f.emisor.nombre)}"/>`,
    `  <cfdi:Receptor Rfc="${xmlEsc(f.receptor.rfc)}" Nombre="${xmlEsc(f.receptor.nombre)}" UsoCFDI="${xmlEsc(f.receptor.usoCfdi)}"/>`,
    "  <cfdi:Conceptos>",
    conceptos,
    "  </cfdi:Conceptos>",
    `  <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${dinero(f.subtotal)}" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos>`,
    `  <cfdi:Complemento><Timbre UUID="${xmlEsc(f.uuid ?? "")}" Estado="${f.estado}" Leyenda="${LEYENDA_SIMULADO}"/></cfdi:Complemento>`,
    "</cfdi:Comprobante>",
    "",
  ].join("\n");
}

/** Texto apto para Helvetica/WinAnsi: deja latin-1 (acentos, ñ, ·) y quita lo demás. */
const latin1 = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "");
const pdfTexto = (s: string) => latin1(s).replace(/[\\()]/g, (c) => "\\" + c);

/** PDF de una página con los datos de la factura y la leyenda SIMULADO. */
export function pdfDeMuestra(f: Factura): Uint8Array {
  const lineas: [number, string][] = [
    [16, `FACTURA DE MUESTRA - ${LEYENDA_SIMULADO.toUpperCase()}`],
    [10, "CFDI 4.0 de ingreso generado por la demo de Inscrito. No tiene sello ni timbre del SAT."],
    [10, ""],
    [11, `Folio fiscal (UUID): ${f.uuid ?? "pendiente"}`],
    [11, `Estado: ${f.estado}`],
    [11, `Emisor: ${f.emisor.nombre} · RFC ${f.emisor.rfc}`],
    [11, `Receptor: ${f.receptor.nombre} · RFC ${f.receptor.rfc} · Uso ${f.receptor.usoCfdi}`],
    [11, `Fecha: ${fechaIso(f.emitidaEn)}`],
    [11, `Forma de pago ${f.formaPago} (transferencia, CoDi/SPEI) · Método ${f.metodoPago} · Moneda MXN`],
    [10, ""],
    ...f.conceptos.map((c): [number, string] => [11, `${c.claveProdServ} · ${c.descripcion} · $${dinero(c.importe)} · IVA exento`]),
    [10, ""],
    [11, `Subtotal: $${dinero(f.subtotal)}    IVA: exento    Total: $${dinero(f.total)} MXN`],
  ];
  let y = 790;
  const contenido = lineas
    .map(([tam, texto]) => {
      const linea = `BT /F1 ${tam} Tf 50 ${y} Td (${pdfTexto(texto)}) Tj ET`;
      y -= tam + 10;
      return linea;
    })
    .join("\n");
  const objetos = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
  ];
  // Todo es latin-1 (un byte por carácter): las posiciones del xref son índices de la cadena.
  let pdf = "%PDF-1.4\n";
  const posiciones: number[] = [];
  objetos.forEach((o, i) => {
    posiciones.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  pdf += posiciones.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0));
}
