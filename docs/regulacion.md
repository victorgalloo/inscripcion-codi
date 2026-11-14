# CoDi: qué dice la regulación y cómo la aplica esta demo

Revisión del 14-nov-2026. Fuentes primarias leídas: Reglas del SPEI de Banxico (Circular 14/2017, compilado con sus reformas hasta la 9/2026), Circular 3/2012 de Banxico (compilado hasta la 3/2026), Circular Única de Bancos (CUB) de la CNBV (compulsa con reformas al 6-nov-2026) y docs/OpenAPI de pey. Lo que no se pudo leer directo va marcado **[no verificado]**. Esto es un resumen de diseño, no asesoría legal.

## Lo que dice la regulación

- **Las reglas de CoDi son de Banxico, no de la CNBV.** En la compulsa de la CUB no aparecen «CoDi», «Mensaje de Cobro» ni «SPEI».[5] CoDi está en la regla 7a. Bis (proceso operativo) y en la 9a. Bis (obligaciones) de las Reglas del SPEI, Circular 14/2017.[2] Del lado del banco, el complemento está en los arts. 17 Bis y 17 Ter de la Circular 3/2012.[4] La CUB entra de forma indirecta, por las reglas de banca electrónica del banco de la familia (Título Quinto, Capítulo X).[5]
- **14-dic-2026.** La Circular 9/2026 (DOF 17-jun-2026) agrega las «Guías para la homologación de la experiencia de usuario en transferencias electrónicas desde dispositivos móviles» (regla 2a., fracc. XXVII Quáter) y obliga a procesar Mensajes de Cobro y Órdenes de Transferencia CoDi conforme a ellas (regla 9a. Bis, fracc. III, inciso a; reglas 7a., 10a. y 71a., fracc. V). Su Transitoria Segunda da a Participantes y Participantes Indirectos hasta el **14 de diciembre de 2026**.[1][2] La Circular 10/2026 hace lo mismo en la Circular 3/2012, con la misma fecha (resumen secundario).[9] **Ninguna obliga a escuelas ni comercios a cobrar con CoDi:** regulan la app del banco.[1] El texto de las Guías **[no verificado]**; según fuentes secundarias definen cuatro etapas (inicio, captura, consistencia/validación y notificación).[10]
- **Pagar con CoDi es obligatorio para bancos con al menos 3,000 cuentas a la vista que ofrecen transferencias desde el celular; cobrar es opcional** (regla 9a. Bis, fracc. II y fracc. I: «El Participante que así lo decida…»; Circular 3/2012, art. 17 Bis, fracc. I).[2][4] El banco de la escuela debe tener CoDi habilitado para recibir; pey lo valida al dar de alta la CLABE.[7]
- **Monto.** Desde la Circular 2/2025 (DOF 21-feb-2025) los bancos deben permitir Mensajes de Cobro de hasta **6,000 UDIS** (regla 9a. Bis, fracc. IV inciso b y fracc. V inciso a), vigente desde el 23-feb-2026.[2][13] Las UDIS se valúan con la UDI del 1 de enero del año del mensaje.[2] Equivale a unos $51–53 mil MXN **[no verificado; cálculo propio]**. La CUB solo exime de registrar la cuenta destino a cobros solicitados por el receptor y autorizados desde el celular **hasta Mediana Cuantía (1,500 UDIS)** (art. 314, párrafo adicionado DOF 1-oct-2019); arriba, la familia puede toparse con más fricción o con sus propios límites (art. 315).[5]
- **Quién genera el cobro.** El **titular de la cuenta que recibe** (Cliente Beneficiario), con un programa de Banxico, del banco o de «algún tercero» conforme al Apéndice AD del Manual (regla 7a. Bis, fracc. I y III).[2] Para cobros por internet (push), la cuenta se registra ante Banxico y se valida con una transferencia de un centavo (reglas 7a. Bis fracc. I-II y 51a. Bis).[2] Aquí: el beneficiario es la **escuela**; pey es el tercero. Que pey esté habilitado ante Banxico **[no verificado]**.
- **Sin agregación ni cuentas concentradoras.** Los Participantes deben abstenerse de procesar órdenes CoDi de servicios que sus clientes ofrezcan a terceros para recibir fondos *a favor de esos terceros* (regla 9a. Bis 1, reforma 15/2022).[2] El dinero cae **directo en la CLABE de la escuela**; pey dice que liquida directo en la cuenta del cliente.[7]
- **Datos del cobro.** El cobrador puede incluir monto, concepto, referencia numérica y vigencia (9a. Bis, fracc. IV, inciso c).[2] El banco de la familia muestra logo CoDi, Folio CoDi, nombre o razón social del beneficiario, monto, concepto, referencia, fecha y hora de vigencia y, si existe, «Nombre Beneficiario 2» (fracc. V, inciso c).[2] Nadie puede modificar lo que puso el cobrador (fracc. IV, inciso d).[2] Concepto de hasta 40 caracteres en la app móvil (Circular 3/2012, art. 17 Ter, fracc. IX).[4]
- **Vigencia y estados.** Sin aceptación al llegar la vigencia, el mensaje queda «vencido» (9a. Bis, fracc. IV, inciso e). Antes, la familia puede **aceptar, rechazar o posponer**; aceptado no se puede rechazar y rechazado no se puede aceptar (fracc. V, inciso d). Hasta 3 reintentos con nueva clave de rastreo si falla la autenticación o la orden (fracc. V, incisos f y g; regla 7a. Bis, fracc. VIII).[2]
- **Autenticación, confirmación y comprobante los pone el banco de la familia:** segundo factor Categoría 3 o 4 (CUB art. 313, fracc. I), confirmación con «información suficiente» (art. 316), comprobante (art. 316 Bis) y notificación (art. 316 Bis 1), que no puede incluir números de cuenta completos, domicilios ni saldos (art. 316 Bis 1, reforma 21-may-2021).[5]
- **Tiempos.** Banxico notifica a cobrador y pagador.[6] El banco envía acreditación, rechazo o devolución (Circular 3/2012, art. 17 Ter, fracc. VIII).[4] Aviso de la acción de la familia en 2 segundos (9a. Bis, fracc. V, inciso e, reforma 1/2022); abono en 5 segundos hasta 1,500 UDIS (regla 19a, reforma 2/2025), con excepciones.[2]
- **Comisiones.** Los bancos no pueden cobrar por generar o recibir Mensajes de Cobro (Circular 3/2012, art. 17 Ter, fracc. XI, inciso iv).[4] Banxico: «Las operaciones por CoDi® no generan comisiones adicionales».[6]
- **Devoluciones y disputas.** No hay contracargos.[6] El banco de la escuela debe permitirle **devolver** una transferencia CoDi (Circular 3/2012, art. 17 Bis, fracc. III).[4] La familia puede reportar un cobro no reconocido (9a. Bis, fracc. V, inciso h) o un monto mayor al acordado (inciso i), ambos a Banxico (Apéndice AJ).[2] La API de pey no tiene endpoint de devolución.[7]
- **Datos personales.** Aplica la LFPDPPP 2025 (DOF 20-mar-2025): aviso de privacidad desde que se recaban los datos (art. 2, fracc. I) con el contenido mínimo del art. 15.[11]
- **En el radar.** La iniciativa de Ley de Economía Digital para Pagos Digitales y Electrónicos seguía en el Congreso al 30-sep-2026 (fuente secundaria); si ya se aprobó **[no verificado]**.[12]

## Roles

| Rol | Quién |
|---|---|
| Cliente Beneficiario: titular de la CLABE, «genera» el cobro | La escuela[2] |
| Programa de un tercero que genera y envía el Mensaje de Cobro | pey[2][7] |
| Participante Emisor: muestra, autentica, confirma y emite comprobante | Banco de la familia[2][5] |
| Participante Receptor: abona el dinero | Banco de la escuela[2] |
| Administrador: valida la cuenta y notifica estados | Banxico[2][6] |
| Orquesta la conversación y el CRM; **nunca** recibe ni concentra fondos | SuperLeads |

SuperLeads no es participante del SPEI y las marcas CoDi y SPEI son de Banxico.[2][6] Cada escuela usa su propia CLABE (`bankAccountId`) en estado ACTIVE; la activación puede tardar hasta 5 días hábiles.[2][7]

## Cómo lo aplica esta demo

| Requisito | Dónde |
|---|---|
| `concept` ≤ 40 caracteres, del catálogo, sin nombre del menor[4][11] | `validarConcepto` y `validarPoliticaCobro` en `src/pagos/tipos.ts` |
| `numRef` de 1 a 7 dígitos[7] | `validarSolicitud` |
| Vigencia de 30–60 min (pey: mínimo 360 s; máximo del Apéndice AD **[no verificado]**)[7] | `validarPoliticaCobro`; la demo usa 30 min |
| Monto igual al que la familia confirmó, sin recargo; sin `fee` ni `applicationFee`[2][4][6][7] | `/api/cobros` rechaza con 422 si no coincide; `PagosCoDiPey` no manda comisiones |
| Monto de la demo ($4,850) por debajo de 1,500 UDIS[5] | `src/demo.ts` |
| Al vencer, cobro **nuevo** con folio y referencia nuevos; el vencido nunca se reutiliza[2] | `ponerCobroNuevo` en `src/vencimiento.ts` |
| pey solo avisa `payment_received`: al vencer se consulta `GET /transaction/{id}` (push) o `GET /transaction/codi/qr/{id}` (QR); PENDING → «vencido o rechazado»[7][8] | `revisarVencimiento` + alarma del Durable Object; en la demo, botón «pasan los 30 min» |
| ntfy al colegio solo tras firma Standard Webhooks ✓, `webhook-id` nuevo y monto + `numRef` iguales al cobro original; si no coinciden, se rechaza y queda en bitácora y log[8] | `src/webhooks.ts`, `conciliar` en `src/conciliacion.ts`, `Tablero.aplicarPago` |
| Antes del push: razón social exacta («Colegio Aurora, S.C. (demo)»), monto, concepto, referencia, vigencia y «sin comisión»; respaldo QR o liga[2][6] | `mensajeAntesDelCobro` en `src/mensajes.ts` |
| App bancaria simulada: logo CoDi (marcador), Folio CoDi, beneficiario, monto, concepto, referencia, vigencia; Aceptar / Rechazar / Posponer[2] | `public/index.html` |
| Después del pago: Folio CoDi, clave de rastreo y CLABE enmascarada (nunca completa)[5] | `enmascararClabe`; la CLABE completa nunca se guarda |
| Aviso de privacidad: el celular se comparte con el proveedor de pagos[11] | Chat de la demo, pie de página y README |
| Devoluciones desde el banco de la escuela; SuperLeads solo registra[4][7] | Nota del lead en revisión |

Pendiente: probar en producción con $0.01 (pey no tiene sandbox) usando la CLABE real de una escuela como beneficiaria.[7]

## Lo que queda abierto

- Texto de las Guías (Banxico) y del Apéndice AD del Manual: vigencia máxima, longitudes de campos, pantallas obligatorias **[no verificado]**.
- Si pey está habilitado o certificado ante Banxico: preguntarle a pey **[no verificado]**.
- El límite real en cada banco para push CoDi arriba de 1,500 UDIS: fuentes secundarias siguen citando 1,500 aunque la regla ya dice 6,000 **[no verificado]**.

Nota de fuentes: el texto de la Circular 3/2012 se leyó de un compilado oficial de Banxico (actualizado hasta la Circular 3/2026, DOF 7-ene-2026) obtenido de un espejo (dubitech.org), porque banxico.org.mx no se dejó descargar con la herramienta de extracción; [4] es la página oficial. La Circular 1/2022 (DOF 23-mar-2022)[3] tiene las definiciones vigentes de «Mensaje de Cobro» y «Orden de Transferencia CoDi».

## Fuentes

1. [DOF – Banxico Circular 9/2026](https://dof.gob.mx/nota_detalle_popup.php?codigo=5790862) (modifica Circular 14/2017; homologación UX móvil), pub. 17-jun-2026
2. [Banxico – Circular 14/2017 Reglas del SPEI](https://www.banxico.org.mx/marco-normativo/normativa-emitida-por-el-banco-de-mexico/circular-14-2017/%7B33EFD864-87F6-89BF-9F19-35E4D80E4CF4%7D.pdf), compilado de modificaciones (8/2019, 1/2022, 15/2022, 2/2025, 9/2026)
3. [DOF – Banxico Circular 1/2022](https://dof.gob.mx/nota_detalle_popup.php?codigo=5646518) (SPEI ampliado, participación indirecta, CoDi), pub. 23-mar-2022
4. [Banxico – Circular 3/2012](https://banxico.org.mx/marco-normativo/normativa-emitida-por-el-banco-de-mexico/circular-3-2012/operaciones-instituciones-cre.html) (operaciones de instituciones de crédito), arts. 17 Bis y 17 Ter
5. [CNBV – Circular Única de Bancos](https://www.cnbv.gob.mx/Normatividad/Disposiciones%20de%20car%C3%A1cter%20general%20aplicables%20a%20las%20instituciones%20de%20cr%C3%A9dito.pdf) (compulsa con reformas al 6-nov-2026)
6. [Banxico – Información sobre CoDi Cobro Digital](https://www.banxico.org.mx/sistemas-de-pago/codi-cobro-digital-banco-me.html)
7. [pey – OpenAPI CoDi API v2026-10-20](https://docs.pey.mx/openapi.json) (POST /codi/pn, /bank-account, /transaction)
8. [pey – Webhook codi.pn.payment_received](https://docs.pey.mx/docs/webhooks/codi/pn)
9. [RegAlert (secundaria) – resumen Circular 10/2026](https://regalert.today/document/circular-10-2026-modifications-to-circular-3-2012-homologation-of-user-experienc-5e443960-0bcf-4ce2-b01b-7c9aa63855a4) (modifica Circular 3/2012), DOF 17-jun-2026
10. [Pagoralia (secundaria) – Guías de homologación UX de Banxico](https://pagoralia.com/guias-de-banxico)
11. [LFPDPPP 2025](https://te.gob.mx/legislacion/media/files/ef345aeb4da50ea.htm) (DOF 20-mar-2025), texto en TEPJF
12. [ClearingPost (secundaria) – iniciativa Ley de Economía Digital para Pagos Digitales](https://clearingpost.com/insights/mexico-digital-economy-law-banxico-qr-codi-dimo)
13. [RegAlert (secundaria) – resumen Circular 2/2025](https://regalert.today/document/circular-2-2025-modifies-circular-14-2017-3e69eebd-1140-46c9-8b49-6e43b16cb5b0), DOF 21-feb-2025
