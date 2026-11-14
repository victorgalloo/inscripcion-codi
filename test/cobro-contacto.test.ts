import { test } from "node:test";
import assert from "node:assert/strict";
import { conciliar, nuevaReferencia, type CobroContacto } from "../src/conciliacion.ts";
import { PagosCoDiMock } from "../src/pagos/mock.ts";
import { interpretarEventoPey } from "../src/pagos/pey.ts";
import { proximoVencimiento, revisarVencimiento } from "../src/vencimiento.ts";
import { validarPoliticaCobro, type SolicitudCobro } from "../src/pagos/tipos.ts";
import { validarFormularioCobro } from "../src/whatsapp-flow.ts";

/** Lo que hace el Worker al recibir el data_exchange: formulario → solicitud → push → cobro guardado. */
async function cobroDesdeFormulario(mock: PagosCoDiMock, data: Record<string, unknown>): Promise<CobroContacto> {
  const f = validarFormularioCobro(data, { soloFicticios: true });
  assert.ok(f.ok);
  const s: SolicitudCobro = {
    montoMXN: f.montoMXN,
    concepto: f.concepto,
    referencia: nuevaReferencia([]),
    vigenciaSegundos: f.vigenciaSegundos,
    metadatos: { escuelaId: "demo-abcdefgh12", cobroContactoId: "cc-1" },
  };
  validarPoliticaCobro(s, { montoConfirmadoMXN: f.montoMXN });
  const c = await mock.crearCobroPush(f.contacto.celular, s);
  return {
    id: "cc-1",
    tipo: "contacto",
    flowToken: "t",
    familia: f.contacto.nombre,
    grado: f.concepto,
    canal: "WhatsApp",
    etapa: "cobro_enviado",
    cobro: { ...c, medio: "push", id: c.transaccionId, creadoEn: 0, estado: "vigente" },
  };
}

const form = { monto: "350.50", concepto: "Colegiatura noviembre", contacto: "mariana", vigencia: "30" };

test("cobro a contacto: el push lleva el celular del contacto enmascarado y la vigencia del formulario", async () => {
  const mock = new PagosCoDiMock({ ahora: () => 1000 });
  const cc = await cobroDesdeFormulario(mock, form);
  assert.equal(cc.cobro!.celular, "•• •••• ••01");
  assert.equal(cc.cobro!.montoMXN, 350.5);
  assert.equal(cc.cobro!.expiraEn, 1000 + 1800);
  assert.match(cc.cobro!.referencia, /^\d{7}$/);
  assert.equal(proximoVencimiento([cc]), 2800);
});

test("cobro a contacto: el webhook de pago se concilia por cobroContactoId y exige monto y referencia", async () => {
  const mock = new PagosCoDiMock();
  const cc = await cobroDesdeFormulario(mock, form);
  const meta = { escuelaId: "demo-abcdefgh12", cobroContactoId: cc.id };

  const bueno = interpretarEventoPey(mock.simularAceptacion(cc.cobro!, meta));
  const r = conciliar([cc], bueno, 5);
  assert.equal(r.resultado.tipo, "conciliado");
  assert.equal(r.leads[0]!.etapa, "pagado");
  assert.equal(r.leads[0]!.pago!.folioCodi, cc.cobro!.folioCodi);
  // El mismo pago otra vez: duplicado, no se paga dos veces.
  assert.equal(conciliar(r.leads, bueno, 6).resultado.tipo, "duplicado");

  const otroMonto = interpretarEventoPey(mock.simularAceptacion(cc.cobro!, meta, 35.05));
  const m = conciliar([cc], otroMonto, 5);
  assert.equal(m.resultado.tipo, "no_coincide");
  assert.equal(m.leads[0]!.etapa, "revision");
});

test("cobro a contacto: al vencer sin pago queda «vencido o rechazado» (Pey no avisa rechazos)", async () => {
  const mock = new PagosCoDiMock({ ahora: () => 1000 });
  const cc = await cobroDesdeFormulario(mock, { ...form, vigencia: "60" });
  const r = await revisarVencimiento(cc, mock, 1000 + 3600);
  assert.equal(r.tipo, "vencido");
  assert.equal(r.tipo === "vencido" && r.lead.cobro!.estado, "vencido_o_rechazado");
});
