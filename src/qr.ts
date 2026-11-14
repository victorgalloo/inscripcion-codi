import qrcode from "qrcode-generator";

/** Dibuja un QR como SVG escalable (sin dependencias del navegador). */
export function qrSvg(texto: string): string {
  const qr = qrcode(0, "M");
  qr.addData(texto, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
