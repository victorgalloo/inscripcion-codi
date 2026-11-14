import { test } from "node:test";
import assert from "node:assert/strict";
import { publicarNtfy, urlPublicacion } from "../src/ntfy.ts";

const aviso = {
  titulo: "Colegio · Familia Demo inscrita y pagada",
  mensaje: "$4,850.00 por CoDi push",
  etiquetas: ["white_check_mark", "school"],
  liga: "https://ejemplo.invalid/?escuela=demo-x",
  prioridad: 4 as const,
};

test("arma la URL de publicación con título UTF-8 en query params", () => {
  const u = new URL(urlPublicacion("https://ntfy.sh", "tema-demo", aviso));
  assert.equal(u.origin + u.pathname, "https://ntfy.sh/tema-demo");
  assert.equal(u.searchParams.get("title"), aviso.titulo);
  assert.equal(u.searchParams.get("tags"), "white_check_mark,school");
  assert.equal(u.searchParams.get("click"), aviso.liga);
  assert.equal(u.searchParams.get("priority"), "4");
});

test("publica con POST y token opcional", async () => {
  let visto: RequestInit | undefined;
  const r = await publicarNtfy("tema-demo", aviso, {
    token: "tk_prueba",
    fetcher: async (_u, init) => {
      visto = init;
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    },
  });
  assert.equal(visto!.method, "POST");
  assert.equal(visto!.body, aviso.mensaje);
  assert.equal((visto!.headers as Record<string, string>).Authorization, "Bearer tk_prueba");
  assert.deepEqual(r, { tema: "tema-demo", status: 200, id: "abc", error: undefined });
});

test("si ntfy falla no truena: regresa status 0 y el error", async () => {
  const r = await publicarNtfy("t", aviso, { fetcher: async () => { throw new Error("sin red"); } });
  assert.equal(r.status, 0);
  assert.equal(r.error, "sin red");
});
