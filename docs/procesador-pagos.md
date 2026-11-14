# Pey como procesador de pagos: qué cubre y qué falta

Revisión de la API pública de Pey ([docs.pey.mx](https://docs.pey.mx), OpenAPI 2026-10-20) para usarla como medio de cobro de los agentes de admisiones (WhatsApp y voz) en colegios privados.

## Qué cubre

| Necesidad | Cómo la cubre Pey |
|---|---|
| Cobro a media conversación | `POST /codi/pn`: push CoDi al celular de la familia (vigencia mínima de 6 min). Respaldo con `POST /codi/qr`. |
| Muchos colegios, una integración | `POST /bank-account` registra la CLABE de cada colegio bajo una sola API key. Cada cobro lleva su `bankAccountId` y el dinero llega directo a la cuenta del colegio. El alta ante Banxico tarda hasta 5 días hábiles y avisa con el webhook `bank_account.updated`. |
| Confirmación y conciliación | Webhooks firmados (Standard Webhooks) `codi.pn.payment_received` y `codi.qr.payment_received`, con `transactionId`, `numRef` (7 dígitos), `bankAccountId`, `metadata.trackingKey` (clave de rastreo SPEI), CLABE y banco del pagador, y la `externalMetadata` que mandamos (lead, ciclo, programa). |
| Familias sin CoDi | Link de pago (`POST /payment-link/create`) con CoDi y tarjeta. La tarjeta pasa por una cuenta de Stripe ligada a la API key. |
| Costo | CoDi no cobra comisión (Banxico) y la API de Pey es gratis «por el momento». |

## Qué falta

- **Webhooks de rechazo y vencimiento** del push. Mientras no existan, consultar `GET /transaction/{id}` y caer al QR con un temporizador.
- **Reembolsos.** No hay endpoint. En CoDi el colegio devuelve por SPEI a la CLABE del pagador, que viene en `metadata.clabe`.
- **Cobro recurrente o domiciliación.** CoDi pide aceptar cada pago. La colegiatura mensual sería un recordatorio más un push cada mes, no un cargo automático.
- **Link de pago sin `bankAccountId`.** Para cobrar con tarjeta, cada colegio necesita su propia API key con su propio Stripe.
- **Ambiente de pruebas.** Viene «próximamente». Hoy se prueba en producción con $0.01.
- **SLA y precios publicados**, y un error claro cuando el celular no tiene CoDi.

## Límites a tener en cuenta

- CoDi es «baja cuantía»: el tope es de **1,500 UDIS (~$13,200 MXN)** por operación o día del pagador. La Circular 2/2025 de Banxico obliga a aceptar mensajes de cobro de hasta 6,000 UDIS. También pesa el MTU que cada familia configuró en su banco. Las inscripciones grandes pueden pasarse del tope y caer a tarjeta o a una transferencia normal.
- Solo unos 25 de 48 bancos con transferencias móviles soportan CoDi, y el push exige que el celular esté validado.

## Decisión de diseño

- **CoDi con Pey va primero** para inscripción y apartado de lugar: el colegio no paga comisión y ve el pago conciliado en segundos.
- **La tarjeta queda de respaldo** (link de pago o el Stripe del colegio), junto con los cobros recurrentes y los montos arriba del tope.
- **La plataforma nunca custodia fondos:** la familia paga directo a la CLABE del colegio, y la comisión de la plataforma se factura aparte.

## Pendiente en este repo

- Mandar `bankAccountId` desde `PagosCoDiPey` en `/codi/qr` y `/codi/pn`.
- Exponer el alta de CLABEs (`POST /bank-account`, `GET /bank-account/{id}`).
- Recibir `bank_account.updated` en `/webhooks/codi`.
