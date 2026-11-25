/**
 * Activación de CoDi dentro del chat, ANTES del primer cobro.
 *
 * CoDi no despegó porque nadie gana comisión y nadie lo enseña. Inscrito lo enseña
 * en el momento justo: la familia dice su banco, el agente le dice si ese banco
 * ofrece CoDi, cómo activarlo ahí mismo y le manda un cobro de prueba chiquito.
 * Si el banco no aparece, no se inventa nada: se ofrece QR desde otra app o liga.
 *
 * Fuente de la lista: codi.org.mx/secundarias/instituciones.html (Banxico),
 * leída el 25-nov-2026. Las ligas son las que publica Banxico para cada banco.
 */

export type EstadoBanco =
  | "paga" // la familia puede aceptar cobros CoDi desde la app de ese banco
  | "no_paga_temporal" // Banxico avisa que hoy no procesa CoDi
  | "solo_cobra"; // solo cobra con la App CoDi Banxico: no sirve para pagar

export interface BancoCoDi {
  nombre: string;
  alias: readonly string[];
  estado: EstadoBanco;
  ayuda: string; // página del banco que enlaza Banxico
}

const b = (nombre: string, alias: string[], ayuda: string, estado: EstadoBanco = "paga"): BancoCoDi => ({
  nombre,
  alias,
  estado,
  ayuda,
});

export const BANCOS_CODI: readonly BancoCoDi[] = [
  b("BBVA", ["bbva", "bancomer"], "https://www.bbva.mx/personas/servicios-digitales/codi-cobro-digital.html"),
  b("Banorte", ["banorte", "ixe"], "http://www.banorte.com/codi"),
  b("Santander", ["santander"], "https://www.santander.com.mx/personas/santander-digital/codi.html"),
  b("Banamex", ["banamex", "citibanamex", "citi"], "https://www.banamex.com/codi/"),
  b("HSBC", ["hsbc"], "https://www.hsbc.com.mx/digital/codi/"),
  b("Scotiabank", ["scotiabank", "scotia"], "https://www.scotiabank.com.mx/Acerca-de-Scotiabank/servicios-bancarios/codi.aspx"),
  b("Banco Azteca", ["azteca", "banco azteca"], "https://www.bancoazteca.com.mx/educacion-financiera/tus-finanzas/finanzas-personales/banca-digital/que-es-codi.html"),
  b("BanCoppel", ["bancoppel", "coppel"], "https://www.bancoppel.com/cobros_digitales/codi.html"),
  b("Inbursa", ["inbursa"], "https://www.inbursa.com/Portal/?page=Document/doc_view_section.asp&id_document=13650&id_category=44"),
  b("BanBajío", ["bajio", "banbajio"], "https://www.bb.com.mx/webcenter/portal/BanBajio/personas/p-banca-electronica/CoDi"),
  b("Banregio", ["banregio"], "https://www.banregio.com/codi.php"),
  b("Hey Banco", ["hey", "hey banco"], "https://banco.hey.inc"),
  b("Afirme", ["afirme"], "https://www.afirme.com/Personas/Banca-en-linea/Afirme-Movil-Lite/Codi.html"),
  b("Ve por Más", ["ve por mas", "vepormas", "bx+"], "https://www.vepormas.com/fwpf/portal/documents/codi"),
  b("Compartamos Banco", ["compartamos"], "https://www.compartamos.com.mx/codi/"),
  b("Mifel", ["mifel"], "https://www.mifel.com.mx/CoDiBancaMifel.html"),
  b("Banco Base", ["banco base", "bbase"], "https://recursos.bancobase.com/codi-la-nueva-forma-de-pagar-en-mexico"),
  b("Monex", ["monex"], "https://www.monex.com.mx/portal/contenido/84/tipos-de-cobranza"),
  b("Bancrea", ["bancrea"], "https://www.bancrea.com/index.php/codi"),
  b("Consubanco", ["consubanco"], "https://www.consubanco.com/otrasopciones/codi"),
  b("Fincomún", ["fincomun"], "https://www.fincomun.com.mx/codi/index.php"),
  b("Banco Inmobiliario Mexicano", ["inmobiliario", "bim"], "https://www.bim.mx/Portal/?page=Document/doc_view_section.asp&id_document=7401"),
  b("PagaTodo", ["pagatodo"], "https://www.pagatodo.com/pequenos-comercios.html"),
  b("STP", ["stp"], "https://stp.mx/cobro-digital/"),
  b("Sabadell", ["sabadell"], "https://www.bancosabadell.mx/personas/es/producto/codi"),
  b("Actinver", ["actinver"], "https://www.actinver.com/webcenter/portal/Actinver/Productos_y_Servicios/Asesoria_Profesional/Inversiones/CoDi"),
  b("Bansí", ["bansi"], "https://www.bansi.com.mx/"),
  b("Intercam", ["intercam"], "https://www.intercam.com.mx/personas/codi-cobro-digital/", "no_paga_temporal"),
  b("Multiva", ["multiva"], "https://www.multiva.com.mx/wps/wcm/connect/Banco/Banco+Multiva/Productos/Banca+Personal/Servicios/Codi/", "no_paga_temporal"),
  b("Kapital", ["kapital"], "https://www.codi.org.mx/secundarias/instituciones.html", "no_paga_temporal"),
  b("ASP Integra", ["asp", "asp integra"], "https://aspintegraopciones.com/codi-paga-facil", "no_paga_temporal"),
  b("Dondé Banco", ["donde", "donde banco"], "https://www.dondebanco.com/codi.html", "solo_cobra"),
  b("Invex", ["invex"], "https://invex.com/codi", "solo_cobra"),
];

export const LISTA_OFICIAL = "https://www.codi.org.mx/secundarias/instituciones.html";

/** Minúsculas, sin acentos ni signos: «BanBajío» → «banbajio». */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Encuentra el banco en lo que escribió la familia («tengo bancomer y nu» → BBVA). Gana el alias más largo. */
export function identificarBanco(texto: string): BancoCoDi | undefined {
  const t = ` ${normalizar(texto)} `;
  let mejor: { banco: BancoCoDi; largo: number } | undefined;
  for (const banco of BANCOS_CODI) {
    for (const alias of banco.alias) {
      if (t.includes(` ${alias} `) && (!mejor || alias.length > mejor.largo)) mejor = { banco, largo: alias.length };
    }
  }
  return mejor?.banco;
}

/** Pasos que publica Banxico; son iguales en todos los bancos (cambia el nombre del menú). */
export const PASOS_ACTIVAR = [
  "Abre la app de tu banco y busca la sección CoDi (suele estar en Pagar, Transferir o Más).",
  "Toca Activar CoDi y acepta los términos.",
  "Confirma tu número de celular: tiene que ser este mismo con el que me escribes.",
  "Elige la cuenta de donde saldrán tus pagos. Listo.",
] as const;

export const PREGUNTA_BANCO =
  "Antes de mandarte el cobro: ¿con qué banco pagas desde tu celular? Así te digo si ya tienes CoDi " +
  "(es gratis y sin comisión) y, si no, cómo activarlo en un minuto.";

export type PasoActivacion = "preguntar_banco" | "activar" | "alternativa";

export interface RespuestaActivacion {
  paso: PasoActivacion;
  banco?: string;
  mensaje: string;
  /** Si viene, el agente manda ya un cobro de prueba por este monto (push al celular del chat). */
  cobroPruebaMXN?: number;
}

const pesosCortos = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: n < 1 ? 2 : 0 });

const ALTERNATIVA =
  "Si tienes otra cuenta en un banco con CoDi, te mando el cobro ahí. Si no, te mando una liga de pago " +
  "(transferencia o tarjeta) y tu lugar queda apartado igual.";

/**
 * Lo que responde el agente cuando la familia dice su banco.
 * `montoPruebaMXN`: $1 en la demo; $0.01 con la cuenta de pruebas de pey.
 */
export function responderBanco(texto: string, montoPruebaMXN = 1): RespuestaActivacion {
  if (!normalizar(texto)) return { paso: "preguntar_banco", mensaje: PREGUNTA_BANCO };
  const banco = identificarBanco(texto);
  if (!banco) {
    return {
      paso: "alternativa",
      mensaje:
        "Ese banco no aparece en la lista oficial de CoDi de Banxico " +
        `(${LISTA_OFICIAL}). ${ALTERNATIVA}`,
    };
  }
  if (banco.estado === "no_paga_temporal") {
    return {
      paso: "alternativa",
      banco: banco.nombre,
      mensaje: `Banxico avisa que ${banco.nombre} por ahora no está procesando pagos CoDi. ${ALTERNATIVA}`,
    };
  }
  if (banco.estado === "solo_cobra") {
    return {
      paso: "alternativa",
      banco: banco.nombre,
      mensaje: `Con ${banco.nombre} CoDi sirve para cobrar, no para pagar. ${ALTERNATIVA}`,
    };
  }
  const prueba = pesosCortos(montoPruebaMXN);
  return {
    paso: "activar",
    banco: banco.nombre,
    cobroPruebaMXN: montoPruebaMXN,
    mensaje: [
      `${banco.nombre} sí tiene CoDi. Si nunca lo has usado, actívalo así:`,
      ...PASOS_ACTIVAR.map((p, i) => `${i + 1}. ${p}`),
      `Guía de ${banco.nombre}: ${banco.ayuda}`,
      `Para probar te mando ahorita un cobro de ${prueba} a tu app. Acéptalo y así sabemos que la inscripción te llegará sin problema.`,
    ].join("\n"),
  };
}

/** Respuesta cuando vuelve el resultado del cobro de prueba. */
export function mensajeTrasPrueba(resultado: "pagado" | "rechazado" | "vencido"): string {
  if (resultado === "pagado") {
    return "Listo, tu CoDi funciona: sin comisión y te llega la confirmación al instante. Ahora sí te mando la inscripción.";
  }
  return (
    "No se completó el cobro de prueba. Revisa que CoDi esté activo con este mismo celular y te lo vuelvo a mandar. " +
    ALTERNATIVA
  );
}
