// Keeps the storage folders tidy: every attachment and photo is stored as
//   <YYYY-MM>/<YYYY-MM-DD>/<Person>/<Project name | No project>/<Task title>/<label - ><file name>
// (photos: <YYYY-MM>/<YYYY-MM-DD>/<Person>/<photo name>.jpg, thumbnails under thumbs/ with the same path).
// The portal uploads new files this way already. This function moves files stored the old way
// (<date>/<code>-<name>) into place: it copies the file, points the portal's records at the new path,
// and deletes the old copy on a later run once nothing refers to it any more.
// Called by the database scheduler with the x-cron-secret header (see supabase/cron.sql). Safe to run repeatedly.
import { admin, cors, json } from "../_shared/common.ts";

type Rec = Record<string, any>;
const OLD = /^\d{4}-\d{2}-\d{2}\/[a-z0-9]{6,12}-/;          // old task file / photo: 2026-11-06/7br6xzsg-name.pdf
const OLD_PHOTO = /^\d{4}-\d{2}-\d{2}\/[a-z0-9]{6,12}\.jpg$/;

const seg = (x: unknown, n = 60) =>
  String(x ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _.,&()+-]+/g, " ")
    .replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "").slice(0, n).trim() || "Untitled";
const uaeDay = (iso: string) => new Date(new Date(iso || Date.now()).getTime() + 4 * 3600e3).toISOString().slice(0, 10);
function nameParts(name: string, label: string) {
  const m = String(name || "file").match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/)!;
  return { base: (label ? seg(label, 50) + " - " : "") + seg(m[1], 90), ext: (m[2] || "").toLowerCase() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const a = admin();
  const { data: ok } = await a.rpc("check_cron_secret", { s: req.headers.get("x-cron-secret") || "" });
  if (!ok) return json({ error: "not allowed" }, 401);
  const body = await req.json().catch(() => ({}));
  const limit = Math.min(200, Number(body.limit) || 60);

  const { data: ppl } = await a.from("people").select("id,name");
  const pname = new Map((ppl || []).map((p: Rec) => [p.id, p.name]));
  const { data: recs, error } = await a.from("records").select("collection,id,data").in("collection", ["tasks", "requests", "projects", "photos", "deleted"]);
  if (error) return json({ error: error.message }, 500);
  const projects = new Map((recs || []).filter((r: Rec) => r.collection === "projects").map((r: Rec) => [r.id, r.data?.name]));

  // every file record -> where it is used
  type Use = { rec: Rec; list: Rec[] };
  const byFile = new Map<string, { f: Rec; uses: Use[]; owners: Set<string>; task?: Rec }>();
  const add = (rec: Rec, list: Rec[], t: Rec | null, owner: string) => (list || []).forEach((f: Rec) => {
    if (!f?.path) return;
    const x = byFile.get(f.path) || { f, uses: [], owners: new Set<string>(), task: t || undefined };
    x.uses.push({ rec, list }); if (owner) x.owners.add(owner); if (!x.task && t) x.task = t; byFile.set(f.path, x);
  });
  for (const r of recs || []) {
    if (r.collection === "tasks") add(r, r.data?.files, r.data, r.data?.owner);
    else if (r.collection === "requests") add(r, r.data?.files, { title: r.data?.f?.title || r.data?.title, projectId: r.data?.f?.projectId, parts: r.data?.f?.parts }, r.data?.to);
    else if (r.collection === "deleted") add(r, r.data?.task?.files, r.data?.task, r.data?.owner);
  }

  const moved: string[] = [], failed: string[] = [], dirty = new Set<Rec>();
  let n = 0;
  for (const [path, x] of byFile) {
    if (n >= limit) break;
    if (!OLD.test(path)) continue;
    const f = x.f, t = x.task || {}, owners = [...x.owners], day = uaeDay(f.at);
    const person = owners.length > 1 ? `${pname.get(f.by) || "Staff"} - assigned to ${owners.length} people` : (pname.get(owners[0]) || pname.get(f.by) || "Staff");
    const proj = t.projectId && projects.get(t.projectId) ? seg(projects.get(t.projectId)) : "No project";
    const part = f.partIdx != null && t.parts && t.parts[f.partIdx] ? `${t.parts[f.partIdx].title} - ${f.stage === "done" ? "on finishing" : "at start"}` : "";
    const folder = `${day.slice(0, 7)}/${day}/${seg(person)}/${proj}/${seg(t.title || "General", 70)}`;
    const nm = nameParts(f.name || path.replace(OLD, ""), part);
    let dest = "";
    for (let i = 1; i <= 20 && !dest; i++) {
      const p = `${folder}/${nm.base}${i > 1 ? ` (${i})` : ""}${nm.ext}`;
      const { error: ce } = await a.storage.from("taskfiles").copy(path, p);
      if (!ce) dest = p;
      else if (!/exist|duplicate|409/i.test(String(ce.message))) { failed.push(`${path}: ${ce.message}`); break; }
    }
    if (!dest) continue;
    n++; moved.push(`${path} -> ${dest}`);
    for (const u of x.uses) { u.list.forEach((g: Rec) => { if (g.path === path) { g.oldPath = path; g.path = dest; g.movedAt = new Date().toISOString(); } }); dirty.add(u.rec); }
  }

  // photos
  for (const r of (recs || []).filter((r: Rec) => r.collection === "photos")) {
    if (n >= limit) break;
    const p = r.data || {}; if (!p.path || !OLD_PHOTO.test(p.path)) continue;
    const day = uaeDay(p.at), folder = `${day.slice(0, 7)}/${day}/${seg(pname.get(p.by) || "Staff")}`, nm = nameParts((p.name || "Photo") + ".jpg", "");
    let dest = "";
    for (let i = 1; i <= 20 && !dest; i++) {
      const q = `${folder}/${nm.base}${i > 1 ? ` (${i})` : ""}${nm.ext}`;
      const { error: ce } = await a.storage.from("photos").copy(p.path, q);
      if (!ce) dest = q; else if (!/exist|duplicate|409/i.test(String(ce.message))) { failed.push(`${p.path}: ${ce.message}`); break; }
    }
    if (!dest) continue;
    if (p.thumb) { const { error: te } = await a.storage.from("photos").copy(p.thumb, "thumbs/" + dest); if (!te) { p.oldThumb = p.thumb; p.thumb = "thumbs/" + dest; } }
    p.oldPath = p.path; p.path = dest; p.movedAt = new Date().toISOString(); n++; moved.push(`photo ${p.oldPath} -> ${dest}`); dirty.add(r);
  }

  for (const r of dirty) {
    const { error: ue } = await a.from("records").update({ data: r.data, updated_by: null, updated_at: new Date().toISOString() }).eq("collection", r.collection).eq("id", r.id);
    if (ue) failed.push(`record ${r.collection}/${r.id}: ${ue.message}`);
  }

  // clean-up: an old copy is deleted only when this function moved it at least 6 hours ago and nothing points to it any more
  const removed: string[] = [];
  if (body.cleanup !== false) {
    const { data: fresh } = await a.from("records").select("collection,data").in("collection", ["tasks", "requests", "photos", "deleted"]);
    const used = new Set<string>(), movedOld = new Map<string, number>();
    const seen = (f: Rec) => { if (!f) return; if (f.path) used.add(f.path); if (f.thumb) used.add(f.thumb);
      if (f.oldPath && f.movedAt) movedOld.set(f.oldPath, Date.parse(f.movedAt)); if (f.oldThumb && f.movedAt) movedOld.set(f.oldThumb, Date.parse(f.movedAt)); };
    for (const r of fresh || []) { const d = r.data || {}; (d.files || []).forEach(seen); (d.task?.files || []).forEach(seen); if (r.collection === "photos") seen(d); }
    for (const b of ["taskfiles", "photos"]) {
      const { data: meta } = await a.rpc("storage_object_ages", { b });
      const stale = (meta || []).map((m: Rec) => m.name as string).filter((nm: string) =>
        !used.has(nm) && movedOld.has(nm) && Date.now() - (movedOld.get(nm) || Date.now()) > 6 * 3600e3);
      for (let i = 0; i < stale.length; i += 100) {
        const { error: re } = await a.storage.from(b).remove(stale.slice(i, i + 100));
        if (!re) removed.push(...stale.slice(i, i + 100));
      }
    }
  }
  return json({ moved: moved.length, removed: removed.length, failed, sample: moved.slice(0, 5) });
});
