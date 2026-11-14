/**
 * Notificaciones push con ntfy (https://ntfy.sh).
 *
 * Publica con un POST a https://ntfy.sh/<tema>. Título, etiquetas y liga van en
 * query params (admiten UTF-8; los encabezados HTTP no). El mensaje va en el cuerpo.
 * Quien quiera recibir el aviso solo se suscribe al tema en la app de ntfy.
 */

export interface AvisoNtfy {
  titulo: string;
  mensaje: string;
  etiquetas: string[]; // emojis de ntfy, p. ej. "white_check_mark"
  liga?: string; // se abre al tocar la notificación
  prioridad?: 1 | 2 | 3 | 4 | 5;
}

export interface ResultadoNtfy {
  tema: string;
  status: number;
  id?: string;
  error?: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function urlPublicacion(base: string, tema: string, aviso: AvisoNtfy): string {
  const u = new URL(`${base.replace(/\/$/, "")}/${encodeURIComponent(tema)}`);
  u.searchParams.set("title", aviso.titulo);
  u.searchParams.set("tags", aviso.etiquetas.join(","));
  if (aviso.liga) u.searchParams.set("click", aviso.liga);
  if (aviso.prioridad) u.searchParams.set("priority", String(aviso.prioridad));
  return u.toString();
}

export async function publicarNtfy(
  tema: string,
  aviso: AvisoNtfy,
  opciones: { base?: string; token?: string; fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<ResultadoNtfy> {
  const base = opciones.base ?? "https://ntfy.sh";
  const fetcher = opciones.fetcher ?? ((i, init) => fetch(i, init));
  try {
    const res = await fetcher(urlPublicacion(base, tema, aviso), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Temas privados (producción): token de acceso de ntfy como secreto del Worker.
        ...(opciones.token ? { Authorization: `Bearer ${opciones.token}` } : {}),
      },
      body: aviso.mensaje,
      signal: AbortSignal.timeout(opciones.timeoutMs ?? 4000),
    });
    const texto = await res.text();
    let id: string | undefined;
    try {
      id = (JSON.parse(texto) as { id?: string }).id;
    } catch {
      /* ntfy responde JSON; si no, solo guardamos el status */
    }
    return { tema, status: res.status, id, error: res.ok ? undefined : texto.slice(0, 200) };
  } catch (e) {
    return { tema, status: 0, error: (e as Error).message };
  }
}
