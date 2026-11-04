// Reset trial data. CEO or General Manager only, at most 2 resets per calendar month (UAE time), company-wide.
// Deletes: all records (tasks, closure reports, meetings, notifications, check-ins, requests, projects, chats,
// photos, AI summaries, attachments list), login/logout locations, uploaded files (photos and task attachments),
// and the project-file text index.
// Keeps: staff list, logins and passwords, reporting lines, server settings and AI keys.
// Actions (POST): { action: "status" } -> { used, limit, last }   { action: "reset", confirm: "RESET" } -> { ok, counts }
import { admin, caller, cors, json } from "../_shared/common.ts";

const LIMIT = 2;
const BUCKETS = ["photos", "taskfiles"];
function monthStartUae(): string {
  const uae = new Date(Date.now() + 4 * 3600_000);
  return new Date(Date.UTC(uae.getUTCFullYear(), uae.getUTCMonth(), 1) - 4 * 3600_000).toISOString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me || !["CEO", "General Manager"].includes(me.role)) return json({ error: "Only the CEO or General Manager can reset data." }, 403);
  const body = await req.json().catch(() => ({}));
  const a = admin();

  const { data: done } = await a.from("trial_resets").select("at,by_person").gte("at", monthStartUae()).order("at", { ascending: false });
  const used = (done || []).length;
  const { data: lastRow } = await a.from("trial_resets").select("at,by_person").order("at", { ascending: false }).limit(1).maybeSingle();

  if (body.action === "status") return json({ used, limit: LIMIT, last: lastRow || null });
  if (body.action !== "reset") return json({ error: "Unknown action." }, 400);
  if (body.confirm !== "RESET") return json({ error: "Type RESET to confirm." }, 400);
  if (used >= LIMIT) return json({ error: `Data has already been reset ${used} times this month. The limit is ${LIMIT} per month.` }, 429);

  const counts: Record<string, number> = {};
  try {
    // Log first, so a reset that fails half-way still counts and is visible.
    const { data: log, error: le } = await a.from("trial_resets").insert({ by_person: me.id, counts: {} }).select("id").single();
    if (le) throw le;

    for (const b of BUCKETS) {
      const { data: names, error } = await a.rpc("storage_object_names", { b });
      if (error) throw error;
      const list = (names || []) as string[];
      for (let i = 0; i < list.length; i += 100) {
        const { error: re } = await a.storage.from(b).remove(list.slice(i, i + 100));
        if (re) throw re;
      }
      counts["files:" + b] = list.length;
    }
    const del = async (table: string, build: (q: any) => any) => {
      const { count, error } = await build(a.from(table).delete({ count: "exact" }));
      if (error) throw error;
      counts[table] = count || 0;
    };
    await del("records", (q) => q.neq("collection", "sys"));
    await del("locations", (q) => q.not("id", "is", null));
    await del("project_file_text", (q) => q.not("file_id", "is", null));
    await del("drive_folders", (q) => q.not("key", "is", null));

    await a.from("trial_resets").update({ counts }).eq("id", log.id);
    // Tells every open portal to reload with the empty data.
    await a.from("records").upsert({ collection: "sys", id: "reset", data: { id: "reset", at: new Date().toISOString(), by: me.id } });
    console.log("trial data reset by", me.id, counts);
    return json({ ok: true, counts, used: used + 1, limit: LIMIT });
  } catch (e) {
    console.error("reset failed:", (e as Error).message, counts);
    return json({ error: "The reset stopped part-way: " + (e as Error).message, counts }, 500);
  }
});
