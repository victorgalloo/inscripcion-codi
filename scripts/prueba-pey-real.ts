/**
 * Prueba REAL contra api.pey.mx (opt-in; no corre en `npm test` ni en CI).
 *   npm run prueba:pey            → crea un QR CoDi de $0.01 con PagosCoDiPey y consulta su estado
 * Llave: ~/.config/pey/api_key_test (chmod 600; la de la CLABE de pruebas de pey) o PEY_API_KEY.
 * Nunca imprime la llave. Lo pagado a la CLABE de pruebas no se devuelve: solo $0.01.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { PagosCoDiPey } from "../src/pagos/pey.ts";

const llave = process.env.PEY_API_KEY || readFileSync(`${homedir()}/.config/pey/api_key_test`, "utf8").trim();
const pey = new PagosCoDiPey({ apiKey: llave });
const ref = String(Date.now() % 10_000_000);
const qr = await pey.crearCobroQR({
  montoMXN: 0.01,
  concepto: "Prueba Inscrito",
  referencia: ref,
  vigenciaSegundos: 30 * 60,
  metadatos: { origen: "prueba-pey-real" },
});
console.log("QR CoDi real creado:", { id: qr.id, montoMXN: qr.montoMXN, referencia: qr.referencia, largoQr: qr.qrString.length });
console.log("Estado:", await pey.estadoCobro({ medio: "qr", id: qr.id }));
