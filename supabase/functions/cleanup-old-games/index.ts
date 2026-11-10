// Löscht Spiele, deren letzte Aktivität (angelegt, gestartet oder beendet) mehr als
// 7 Tage zurückliegt – samt aller Fotos im Storage-Bucket „photos“. Außerdem werden
// Foto-Ordner ohne zugehöriges Spiel entfernt. Läuft täglich per pg_cron.
// Der Aufruf ist unbedenklich: Es wird nur gelöscht, was ohnehin abgelaufen ist.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_AGE_DAYS = 7;
const BUCKET = "photos";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString();

  const { data: games, error } = await sb.from("games").select("id, created_at, started_at, finished_at");
  if (error) return json({ error: error.message }, 500);

  const lastActivity = (g: Record<string, string | null>) =>
    [g.created_at, g.started_at, g.finished_at].filter(Boolean).sort().pop() as string;
  const expired = (games ?? []).filter((g) => lastActivity(g) < cutoff).map((g) => g.id as string);
  const alive = new Set((games ?? []).map((g) => g.id as string).filter((id) => !expired.includes(id)));

  // Fotos: jeder Ordner gehört zu einem Spiel; alles ohne lebendes Spiel kommt weg
  let removedFiles = 0;
  const { data: folders, error: listErr } = await sb.storage.from(BUCKET).list("", { limit: 1000 });
  if (listErr) return json({ error: listErr.message }, 500);
  for (const folder of folders ?? []) {
    if (alive.has(folder.name)) continue;
    for (let guard = 0; guard < 100; guard++) {
      const { data: files } = await sb.storage.from(BUCKET).list(folder.name, { limit: 100 });
      if (!files?.length) break;
      const paths = files.map((f) => `${folder.name}/${f.name}`);
      const { error: rmErr } = await sb.storage.from(BUCKET).remove(paths);
      if (rmErr) return json({ error: rmErr.message, removedFiles }, 500);
      removedFiles += paths.length;
      if (files.length < 100) break;
    }
  }

  // Spieldaten (Spieler, Runden, Fragen, Standorte … hängen per Kaskade dran)
  let removedGames = 0;
  if (expired.length) {
    const { error: delErr, count } = await sb.from("games").delete({ count: "exact" }).in("id", expired);
    if (delErr) return json({ error: delErr.message, removedFiles }, 500);
    removedGames = count ?? expired.length;
  }

  return json({ removedGames, removedFiles, cutoff });
});
