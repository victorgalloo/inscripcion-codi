# Inscrito · guion del video (≤ 3 min)

Versión 1 · 27-nov-2026. Regla del hackatón (§10): el video tiene que enseñar **un cobro CoDi completo**, desde que se
genera hasta que el proyecto reacciona. Aquí ese cobro es real (API de pey en producción, push de $0.01) y aparece
en la escena 3. Todo lo demás (familia, colegio, montos) es ficticio.

**Historia en una línea:** tres agentes que trabajan solos para el colegio: uno hace que la familia active CoDi, otro
cobra cada colegiatura por CoDi y el tercero manda la factura. La familia paga con un toque en su banco y el dinero
llega directo a la cuenta del colegio.

**Personajes (ficticios):** Mariana, mamá de Leo (2.º de primaria) · Colegio Valle Alto, 300 alumnos · colegiatura
$4,850 · día de pago: el 10 de cada mes.

**Pantalla:** a la izquierda el celular de Mariana (WhatsApp y su app del banco), a la derecha el tablero del colegio.
Voz en off en primera persona del equipo.

| # | Tiempo | Escena | Qué se ve | Voz en off | Real o demo |
|---|---|---|---|---|---|
| 0 | 0:00–0:15 | El problema | Chat de un colegio: «¿me pasa la CLABE?», foto de un comprobante borroso, hoja de conciliación | «Así se cobra hoy una colegiatura: CLABE dictada, foto del comprobante y alguien que concilia a mano. Con tarjeta, el colegio paga hasta 1.12 % de comisión. CoDi cobra gratis y al instante, pero casi nadie lo usa: nadie gana por enseñarlo.» | Grabación de pantalla |
| 1 | 0:15–0:45 | **Agente 1 · Adopción** | WhatsApp: «¿Tu banco tiene CoDi?» → Mariana contesta su banco → 4 pasos para activarlo en ESE banco → «Te mando un cobro de prueba» | «El primer agente no cobra: enseña. Le pregunta a la familia su banco, le dice cómo activar CoDi en esa app y le manda un cobro de prueba. Su meta es una sola: que la familia quede en CoDi.» | Demo (`src/activacion.ts`) |
| 2 | 0:45–1:00 | Contador de adopción | Tablero: «Familias con CoDi: 212 de 300» sube a 213 | «El colegio ve cuántas familias ya pueden pagar sin comisión.» | Demo |
| 3 | 1:00–1:45 | **Agente 2 · Cobranza** (el cobro real) | Tablero: 10 de diciembre, 9:00. El agente manda el push CoDi y el WhatsApp. **En vivo:** llega la solicitud al celular → Mariana acepta en su banco → el webhook firmado llega → la fila pasa a «Pagado» con clave de rastreo | «El día de pago, el segundo agente manda la solicitud de cobro directo al celular de la familia y un WhatsApp que la explica. Mariana acepta en su banco… y en segundos el colegio lo ve pagado, con su clave de rastreo. Nadie concilió nada.» | **Real**: `POST /codi/pn` en `api.pey.mx`, $0.01, webhook `/webhooks/codi`, `GET /transaction/{id}` |
| 4 | 1:45–2:05 | La decisión del agente | Otra familia no paga: 18:00 nuevo push · día siguiente push + QR · día 3 push + QR + enlace · día 5 aviso al colegio | «Si alguien no paga, el agente no insiste a ciegas: cambia de camino, del push al QR y al enlace, y al quinto día le pasa el caso al colegio. Nunca dos cobros juntos.» | Demo (`src/cobranza.ts`) |
| 5 | 2:05–2:25 | **Agente 3 · Facturación** | En cuanto queda «Pagado»: factura de la colegiatura timbrada y enviada por WhatsApp con PDF y XML | «Y en cuanto entra el pago, el tercer agente factura solo y se la manda a la familia. Nadie la pidió y nadie la capturó.» | Demo (`src/facturador.ts`) |
| 6 | 2:25–2:40 | Cuando quien llega es un agente | Un asistente de IA consulta `/agente/oferta.json`, pide el lugar y recibe `402` con el cobro CoDi; la familia aprueba en su banco; `200 Inscrito` | «Y si mañana quien inscribe es el asistente de IA de la familia, recibe un 402 en pesos con el cobro CoDi. La familia aprueba en su banco y el lugar queda apartado.» | Demo (`/api/agente/apartar`) |
| 7 | 2:40–3:00 | Cierre | Diagrama: adopción → cobranza → conciliación → factura. Cifra: «un colegio de 300 alumnos = ~3,300 cobros CoDi al año». Lista del API: push, QR, enlace de pago, webhooks, consulta de transacción | «Tres agentes, cero comisiones, y el dinero va directo del banco de la familia a la cuenta del colegio: nunca lo tocamos. Listo, ya quedó: está inscrito.» | Gráfico |

## Qué falta para poder grabarlo
1. Tablero con la familia ficticia y su calendario del mes (conectar `cobranza.ts` a la alarma del Durable Object).
2. Contador «familias con CoDi» en el tablero (sale de `activacion.ts`).
3. Factura visible en el tablero cuando la fila pasa a «Pagado».
4. Toma real del push en el celular (la de $0.01 ya funcionó el 24-nov; regrabarla con la pantalla dividida).
5. Para la entrega final: el mismo cobro con la CLABE propia en producción.

## Reglas del guion
- La escena 3 no se recorta: es la que comprueba el requisito del cobro real.
- Se dice «usa CoDi», nunca algo que suene a producto oficial de pey o de Banxico.
- No aparece el nombre de ningún proveedor de facturación.
- Ningún dato de colegios o familias reales.
- Si pasa de 3:00, se recorta primero la escena 6, luego la 2.
