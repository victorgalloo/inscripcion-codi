/**
 * Datos de DEMOSTRACIÓN. Todo es inventado: escuela, familias, montos y celular.
 */
import type { Lead } from "./conciliacion.ts";

export const ESCUELA_DEMO = {
  nombre: "Colegio Aurora (demo)",
  /**
   * Razón social EXACTA del titular de la CLABE: es el «Beneficiario» que la familia
   * ve en su app bancaria, y el agente la repite igual en WhatsApp antes del cobro.
   */
  razonSocial: "Colegio Aurora, S.C. (demo)",
  ciclo: "2027-28",
};

/**
 * Catálogo de cuotas ficticio. El monto lo decide el servidor, nunca el navegador.
 * $4,850 queda muy por debajo de 1,500 UDIS (Mediana Cuantía, CUB art. 314), así la
 * familia no se topa con pasos extra de su banco.
 */
export const CUOTA_INSCRIPCION = {
  grado: "1° primaria",
  montoMXN: 4850,
  // ≤ 40 caracteres, sin datos del menor. Sin acentos ni símbolos: viaja en la orden SPEI
  // y no todos los bancos los muestran bien.
  concepto: "Inscripcion 2027-28 1o primaria",
};

/** Celular ficticio de la familia de la demo (no es un número real). */
export const CELULAR_DEMO = "0000000042";

/** 30 min: dentro del rango de 30–60 min que usa el proyecto (Pey acepta desde 360 s). */
export const VIGENCIA_SEGUNDOS = 30 * 60;

export function leadsDeEjemplo(): Lead[] {
  return [
    { id: "ej-1", familia: "Familia Navarro", grado: "3° primaria", canal: "WhatsApp", etapa: "nuevo" },
    { id: "ej-2", familia: "Familia Ibarra", grado: "Kínder 2", canal: "WhatsApp", etapa: "informes" },
    { id: "ej-3", familia: "Familia Salas", grado: "1° secundaria", canal: "WhatsApp", etapa: "cobro_enviado" },
    {
      id: "ej-4",
      familia: "Familia Cordero",
      grado: "2° primaria",
      canal: "WhatsApp",
      etapa: "pagado",
      pago: {
        medio: "push",
        transaccionId: "DEMO-EJEMPLO",
        montoMXN: 4850,
        comisionMXN: 0,
        pagadoEn: 0,
        conciliadoEn: 0,
      },
    },
  ];
}
