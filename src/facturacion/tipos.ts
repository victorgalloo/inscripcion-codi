/**
 * Facturacion — la única puerta entre Inscrito y quien timbra los CFDI.
 *
 * Misma idea que `PagosCoDi`: el agente facturador (src/facturador.ts), el tablero y
 * las rutas /api/facturas solo conocen esta interfaz y este contrato JSON. Hay dos
 * implementaciones:
 *
 *   - `FacturacionMock` (src/facturacion/mock.ts): timbrado SIMULADO para la demo pública.
 *     UUID con forma real, PDF y XML de muestra marcados «SIMULADO, sin validez fiscal».
 *   - `FacturacionHttp` (src/facturacion/http.ts): cualquier proveedor de timbrado (PAC)
 *     por HTTP. Manda ESTE contrato canónico y espera ESTA respuesta canónica. Conectar
 *     un proveedor concreto = un traductor delgado detrás de FACTURACION_URL, o una
 *     clase nueva que implemente `Facturacion`. El resto del sistema no cambia.
 *
 * Reglas del CFDI 4.0 (Anexo 20) que aplica este contrato:
 *   - Tipo de comprobante «I» (ingreso), exportación «01» (no aplica), moneda MXN.
 *   - Forma de pago «03» (transferencia electrónica de fondos): CoDi viaja por SPEI.
 *   - Método de pago «PUE» (pago en una sola exhibición): solo se factura lo ya pagado.
 *   - Sin datos fiscales de la familia → público en general: RFC genérico XAXX010101000,
 *     régimen «616» (sin obligaciones fiscales), uso «S01» (sin efectos fiscales) y como
 *     código postal el del lugar de expedición (el del colegio).
 *   - Servicios de enseñanza con reconocimiento de validez oficial: exentos de IVA
 *     (Ley del IVA, art. 15, fracc. IV). Objeto de impuesto «02» con traslado de IVA
 *     («002») tipo factor «Exento»: sin tasa ni importe; total = subtotal.
 *   - Unidad «E48» (unidad de servicio).
 *   - Complemento de instituciones educativas privadas (IEDU 1.0): OPCIONAL por concepto.
 *     Lleva nombre y CURP del alumno: viaja al proveedor y NUNCA se guarda aquí.
 *
 * Clave de producto o servicio (c_ClaveProdServ) por nivel: NO la fijamos en el código
 * porque no pudimos confirmarla contra el catálogo vigente del SAT. Cada colegio la
 * configura (FACTURACION_CLAVES_PRODSERV) con la que le indique su contador. Mientras no
 * se configure se usa «01010101» («No existe en el catálogo») y la factura lo marca.
 */
import type { SecretoBoveda } from "../pagos/fabrica.ts";

export type ProveedorFacturacion = "mock" | "http";

/** RFC genérico para operaciones con el público en general (receptor sin datos fiscales). */
export const RFC_PUBLICO_EN_GENERAL = "XAXX010101000";
export const NOMBRE_PUBLICO_EN_GENERAL = "PUBLICO EN GENERAL";
/** c_RegimenFiscal 616: Sin obligaciones fiscales. */
export const REGIMEN_PUBLICO_EN_GENERAL = "616";
/** c_UsoCFDI S01: Sin efectos fiscales. */
export const USO_PUBLICO_EN_GENERAL = "S01";
/** c_FormaPago 03: Transferencia electrónica de fondos (CoDi es SPEI). */
export const FORMA_PAGO_TRANSFERENCIA = "03";
/** c_ClaveUnidad E48: Unidad de servicio. */
export const CLAVE_UNIDAD_SERVICIO = "E48";
/** c_ClaveProdServ 01010101: «No existe en el catálogo». Marcador hasta que el colegio configure la suya. */
export const CLAVE_PROD_SERV_SIN_CONFIGURAR = "01010101";

export type NivelEducativo =
  | "Preescolar"
  | "Primaria"
  | "Secundaria"
  | "Profesional técnico"
  | "Bachillerato o su equivalente";

/** Clave c_ClaveProdServ por nivel educativo (la decide el colegio con su contador). */
export type ClavesProdServ = Partial<Record<NivelEducativo, string>>;

/** Datos fiscales del receptor (la familia), tal como vienen en su Constancia de Situación Fiscal. */
export interface DatosFiscales {
  rfc: string;
  /** Nombre o razón social EXACTO de la constancia, sin régimen societario. */
  nombre: string;
  /** Código postal del domicilio fiscal (5 dígitos). */
  codigoPostal: string;
  /** c_RegimenFiscal (3 dígitos), p. ej. 605 sueldos y salarios. */
  regimenFiscal: string;
  /** c_UsoCFDI, p. ej. D10 (pagos por servicios educativos) si quiere deducir la colegiatura. */
  usoCfdi: string;
}

/** El colegio que factura. */
export interface Emisor {
  rfc: string;
  nombre: string;
  regimenFiscal: string;
  /** Lugar de expedición: código postal del colegio. */
  codigoPostal: string;
}

/** Complemento IEDU 1.0 (instituciones educativas privadas). Opcional. */
export interface ComplementoIEDU {
  version: "1.0";
  nombreAlumno: string;
  CURP: string;
  nivelEducativo: NivelEducativo;
  /** Clave del reconocimiento de validez oficial de estudios (RVOE / clave de centro de trabajo). */
  autRVOE: string;
  /** RFC de quien paga, si es distinto del receptor. */
  rfcPago?: string;
}

export interface Concepto {
  claveProdServ: string;
  claveUnidad: typeof CLAVE_UNIDAD_SERVICIO;
  cantidad: 1;
  descripcion: string;
  valorUnitario: number;
  importe: number;
  /** c_ObjetoImp 02: sí objeto de impuesto. */
  objetoImp: "02";
  /** IVA exento: ni tasa ni importe. */
  traslado: { impuesto: "002"; tipoFactor: "Exento"; base: number };
  /** Solo viaja al proveedor; no se guarda. */
  iedu?: ComplementoIEDU;
}

/** Lo que el agente le pide timbrar al proveedor (contrato canónico, JSON). */
export interface SolicitudFactura {
  /** Llave de idempotencia: un pago = una factura. Se manda también como Idempotency-Key. */
  llave: string;
  tipoComprobante: "I";
  exportacion: "01";
  moneda: "MXN";
  formaPago: typeof FORMA_PAGO_TRANSFERENCIA;
  metodoPago: "PUE";
  lugarExpedicion: string;
  /** Unix (s) en que se recibió el pago. */
  fechaPago: number;
  emisor: Emisor;
  receptor: DatosFiscales;
  publicoEnGeneral: boolean;
  /**
   * Con RFC genérico y nombre «PUBLICO EN GENERAL» el CFDI 4.0 pide InformacionGlobal.
   * c_Periodicidad 01 (diario) y el mes (c_Meses) y año del pago.
   */
  informacionGlobal?: { periodicidad: "01"; meses: string; anio: number };
  conceptos: Concepto[];
  subtotal: number;
  total: number;
  /** Sustitución: c_TipoRelacion 04 con el folio fiscal del CFDI que se reemplaza. */
  cfdiRelacionados?: { tipoRelacion: "04"; uuids: string[] };
  /** Datos propios (escuelaId, leadId). El proveedor los regresa en la respuesta y en el webhook. */
  metadatos: Record<string, string>;
}

export type EstadoFactura = "pendiente" | "timbrada" | "cancelada" | "rechazada";

/**
 * c_MotivoCancelacion: 01 comprobante emitido con errores con relación (exige folio
 * sustituto), 02 con errores sin relación, 03 no se llevó a cabo la operación,
 * 04 operación nominativa relacionada en una factura global.
 */
export type MotivoCancelacion = "01" | "02" | "03" | "04";

export interface SolicitudCancelacion {
  motivo: MotivoCancelacion;
  /** Obligatorio con motivo 01: UUID del CFDI que sustituye al cancelado. */
  folioSustitucion?: string;
}

/** Respuesta canónica del proveedor. Es también lo que se guarda junto al cobro. */
export interface Factura {
  proveedor: ProveedorFacturacion;
  /** Id de la factura en el proveedor. */
  id: string;
  llave: string;
  /** Folio fiscal (UUID del timbre). Ausente mientras está pendiente. */
  uuid?: string;
  estado: EstadoFactura;
  emisor: { rfc: string; nombre: string };
  receptor: { rfc: string; nombre: string; usoCfdi: string };
  publicoEnGeneral: boolean;
  conceptos: { claveProdServ: string; descripcion: string; importe: number }[];
  subtotal: number;
  total: number;
  moneda: "MXN";
  formaPago: string;
  metodoPago: "PUE";
  /** Ligas a PDF y XML (del proveedor, o internas en el mock). */
  pdfUrl?: string;
  xmlUrl?: string;
  /** Unix (s) de emisión / timbrado. */
  emitidaEn: number;
  canceladaEn?: number;
  motivoCancelacion?: MotivoCancelacion;
  /** UUID que la sustituye (si se canceló con motivo 01). */
  sustituidaPor?: string;
  /** Por qué el proveedor (o el SAT) la rechazó. */
  motivoRechazo?: string;
  metadatos: Record<string, string>;
}

/** Evento canónico que manda el proveedor a POST /webhooks/facturacion. */
export interface EventoFactura {
  tipo: "factura.timbrada" | "factura.cancelada" | "factura.rechazada";
  factura: Factura;
}

export interface Facturacion {
  readonly proveedor: ProveedorFacturacion;
  /** Timbra un CFDI de ingreso. Idempotente por `solicitud.llave`. */
  emitir(solicitud: SolicitudFactura): Promise<Factura>;
  consultar(id: string): Promise<Factura>;
  cancelar(id: string, solicitud: SolicitudCancelacion): Promise<Factura>;
  /** PDF o XML de una factura (el mock lo arma desde la factura guardada). */
  archivo(factura: Factura, formato: "pdf" | "xml"): Promise<{ tipo: string; cuerpo: Uint8Array | string }>;
}

/** Lo que se guarda junto al cobro del lead (src/conciliacion.ts, Lead.factura). */
export interface RegistroFactura {
  /** Llave del pago (transaccionId): un pago = una factura vigente. */
  llave: string;
  /**
   * timbrando  ya se pidió al proveedor (marca previa: un webhook repetido no vuelve a timbrar)
   * pendiente  el proveedor la aceptó y avisará por webhook
   * timbrada   lista y entregada a la familia
   * cancelada  cancelada sin sustituto
   * rechazada  el proveedor o el SAT la rechazó
   * error      tres intentos fallidos: el colegio ya fue avisado
   */
  estado: "timbrando" | EstadoFactura | "error";
  factura?: Factura;
  /** Facturas sustituidas (canceladas con motivo 01), solo auditoría. */
  anteriores?: Factura[];
  intentos: number;
  error?: string;
  /** Mensaje de WhatsApp para la familia (la liga al PDF va aparte, en `ligaPdf`). */
  mensajeFamilia?: string;
  /** Unix (s) límite para pedir la factura a su nombre (fin del mes de emisión). */
  datosFiscalesHasta?: number;
}

/** Configuración de un proveedor por variables (ver src/facturacion/fabrica.ts). */
export interface EnvFacturacion {
  FACTURACION_PROVEEDOR?: ProveedorFacturacion;
  FACTURACION_URL?: string;
  /** Secreto de texto (wrangler secret put) o binding de la bóveda (Secrets Store). */
  FACTURACION_API_KEY?: string | SecretoBoveda;
  FACTURACION_AUTH_CABECERA?: string;
  FACTURACION_AUTH_PREFIJO?: string;
  FACTURACION_RUTA_EMITIR?: string;
  FACTURACION_RUTA_CONSULTAR?: string;
  FACTURACION_RUTA_CANCELAR?: string;
  FACTURACION_RUTA_ARCHIVO?: string;
  FACTURACION_WEBHOOK_SECRET?: string | SecretoBoveda;
  FACTURACION_EMISOR_RFC?: string;
  FACTURACION_EMISOR_NOMBRE?: string;
  FACTURACION_EMISOR_REGIMEN?: string;
  FACTURACION_EMISOR_CP?: string;
  /** JSON nivel → clave c_ClaveProdServ, p. ej. {"Primaria":"…","Secundaria":"…"}. */
  FACTURACION_CLAVES_PRODSERV?: string;
}

// ───────────────────────── validaciones ─────────────────────────

/** RFC: 3 (moral) o 4 (física) letras, fecha AAMMDD y homoclave de 3. */
const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

export function normalizarDatosFiscales(d: DatosFiscales): DatosFiscales {
  return {
    rfc: d.rfc.trim().toUpperCase(),
    nombre: d.nombre.trim().toUpperCase().replace(/\s+/g, " "),
    codigoPostal: d.codigoPostal.trim(),
    regimenFiscal: d.regimenFiscal.trim(),
    usoCfdi: d.usoCfdi.trim().toUpperCase(),
  };
}

export function validarDatosFiscales(d: DatosFiscales): void {
  if (!RFC_RE.test(d.rfc)) throw new Error("RFC inválido");
  if (d.rfc === RFC_PUBLICO_EN_GENERAL) throw new Error("Para facturar a tu nombre usa tu RFC, no el genérico");
  if (!d.nombre || d.nombre.length > 254) throw new Error("Falta el nombre o razón social");
  if (!/^[0-9]{5}$/.test(d.codigoPostal)) throw new Error("El código postal debe tener 5 dígitos");
  if (!/^[0-9]{3}$/.test(d.regimenFiscal)) throw new Error("El régimen fiscal es una clave de 3 dígitos (p. ej. 605)");
  if (!/^[A-Z][0-9]{2}$/.test(d.usoCfdi)) throw new Error("El uso del CFDI es una clave como D10 o G03");
}

/** Datos fiscales a partir de un cuerpo JSON cualquiera (lanza si faltan). */
export function datosFiscalesDe(o: Record<string, unknown>): DatosFiscales {
  const d = normalizarDatosFiscales({
    rfc: String(o.rfc ?? ""),
    nombre: String(o.nombre ?? o.razonSocial ?? ""),
    codigoPostal: String(o.codigoPostal ?? o.cp ?? ""),
    regimenFiscal: String(o.regimenFiscal ?? ""),
    usoCfdi: String(o.usoCfdi ?? ""),
  });
  validarDatosFiscales(d);
  return d;
}

export const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export function validarCancelacion(c: SolicitudCancelacion): void {
  if (!["01", "02", "03", "04"].includes(c.motivo)) throw new Error("Motivo de cancelación inválido (01 a 04)");
  if (c.motivo === "01" && !UUID_RE.test(c.folioSustitucion ?? "")) {
    throw new Error("El motivo 01 exige el folio fiscal (UUID) del CFDI que sustituye");
  }
  if (c.motivo !== "01" && c.folioSustitucion) throw new Error("El folio de sustitución solo va con el motivo 01");
}

/** Convierte el cuerpo de un webhook (ya verificado) en un EventoFactura. */
export function interpretarEventoFactura(payload: unknown): EventoFactura {
  const p = payload as Partial<EventoFactura> | null;
  const tipos = ["factura.timbrada", "factura.cancelada", "factura.rechazada"];
  if (!p || typeof p !== "object" || !tipos.includes(String(p.tipo))) throw new Error("Evento de facturación no soportado");
  const f = p.factura;
  if (!f || typeof f.id !== "string" || typeof f.llave !== "string") throw new Error("El evento no trae la factura");
  return { tipo: p.tipo as EventoFactura["tipo"], factura: { ...f, metadatos: f.metadatos ?? {} } };
}

/** Redondeo a centavos. */
export const centavos = (n: number) => Math.round(n * 100) / 100;
