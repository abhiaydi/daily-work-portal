// Project files in Google Drive, and the project AI assistant.
//
// Google Drive is reached with a refresh token for one company Google account (secrets below).
// The portal uses the "drive.file" permission: it can only see the files and folders it created itself.
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//
// Actions (POST):
//   status                      -> { drive: bool, ai: bool }
//   upload   (multipart form)   -> project, file  : AI picks a folder + clear file name, file is stored in Drive
//   download { file }           -> the file itself (the portal checks project membership, so Drive sharing isn't needed)
//   remove   { file }           -> moves the file to the Drive bin and removes it from the portal
//   ask      { project, question } -> { answer, file_ids }   AI answers from the schedule, chat and file contents
//
// Only the project's creator, its members, the CEO and the GM can use a project's files.
import { admin, aiReady, askAI, caller, cors, json } from "../_shared/common.ts";

type Rec = Record<string, any>;
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const MAX_BYTES = 25 * 1024 * 1024;
const ROOT_NAME = "Daily Work Portal - Projects";

const driveReady = () => !!(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET") && Deno.env.get("GOOGLE_REFRESH_TOKEN"));

let tok = { value: "", until: 0 };
async function token(): Promise<string> {
  if (tok.value && Date.now() < tok.until) return tok.value;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!, grant_type: "refresh_token",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Google sign-in failed: ${d.error_description || d.error || r.status}. The Google keys may be wrong or expired.`);
  tok = { value: d.access_token, until: Date.now() + (Number(d.expires_in || 3600) - 120) * 1000 };
  return tok.value;
}
async function g(path: string, init: RequestInit = {}) {
  const r = await fetch(path.startsWith("http") ? path : DRIVE + path, { ...init, headers: { Authorization: `Bearer ${await token()}`, ...(init.headers || {}) } });
  if (!r.ok) { const t = await r.text(); throw new Error(`Google Drive error ${r.status}: ${t.slice(0, 300)}`); }
  return r;
}
async function createFolder(name: string, parent: string | null) {
  const r = await g("/files?fields=id,webViewLink&supportsAllDrives=true", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
  });
  return await r.json() as { id: string; webViewLink: string };
}
/** Folder ids are remembered in the table drive_folders (server only). */
async function ensureFolder(key: string, name: string, parent: string | null) {
  const a = admin();
  const { data } = await a.from("drive_folders").select("folder_id,url").eq("key", key).maybeSingle();
  if (data) return { id: data.folder_id as string, url: data.url as string };
  const f = await createFolder(name, parent);
  await a.from("drive_folders").upsert({ key, folder_id: f.id, url: f.webViewLink, name });
  return { id: f.id, url: f.webViewLink };
}
async function uploadBytes(meta: Rec, bytes: Uint8Array, mime: string) {
  const boundary = "dwp" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const body = new Blob([
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes, enc.encode(`\r\n--${boundary}--`),
  ]);
  const r = await g(`${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,mimeType,size`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  return await r.json() as Rec;
}

/* Reading what is inside a file: Google converts a temporary copy (Word/PDF -> Docs, Excel -> Sheets,
   PowerPoint -> Slides; scanned PDFs and photos are read with OCR), the text is exported, the copy deleted. */
const ext = (n: string) => (n.match(/\.([a-z0-9]{1,6})$/i)?.[1] || "").toLowerCase();
function convertTo(name: string, mime: string): [string, string] | null {
  const e = ext(name);
  if (["doc", "docx", "odt", "rtf", "pdf", "jpg", "jpeg", "png"].includes(e) || /pdf|word|opendocument.text|image\/(jpeg|png)/.test(mime))
    return ["application/vnd.google-apps.document", "text/plain"];
  if (["xls", "xlsx", "ods"].includes(e) || /spreadsheet|excel/.test(mime)) return ["application/vnd.google-apps.spreadsheet", "text/csv"];
  if (["ppt", "pptx", "odp"].includes(e) || /presentation|powerpoint/.test(mime)) return ["application/vnd.google-apps.presentation", "text/plain"];
  return null;
}
const plainText = (name: string, mime: string) => /^text\//.test(mime) || ["txt", "csv", "md", "json", "xml", "html"].includes(ext(name));
async function readText(name: string, mime: string, bytes: Uint8Array, parent: string): Promise<string> {
  try {
    if (plainText(name, mime)) return new TextDecoder().decode(bytes.slice(0, 400_000));
    const c = convertTo(name, mime); if (!c) return "";
    const tmp = await uploadBytes({ name: "_reading_" + name, mimeType: c[0], parents: [parent] }, bytes, mime || "application/octet-stream");
    try {
      const r = await g(`/files/${tmp.id}/export?mimeType=${encodeURIComponent(c[1])}`);
      return (await r.text()).slice(0, 400_000);
    } finally { await g(`/files/${tmp.id}?supportsAllDrives=true`, { method: "DELETE" }).catch(() => {}); }
  } catch (e) { console.error("readText", (e as Error).message); return ""; }
}

const clean = (s: string, max: number) => String(s || "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
function parseJson(t: string): Rec | null {
  const m = t.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const uaeDate = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

async function loadProject(id: string) {
  const { data } = await admin().from("records").select("data").eq("collection", "projects").eq("id", id).maybeSingle();
  return data?.data as Rec | undefined;
}
const canUse = (p: Rec | undefined, me: Rec) => !!p && p.status !== "deleted" &&
  (p.owner === me.id || (p.members || []).includes(me.id) || ["CEO", "General Manager"].includes(me.role));
async function projectFiles(pid: string) {
  const { data } = await admin().from("records").select("data").eq("collection", "pfiles").filter("data->>projectId", "eq", pid);
  return (data || []).map((r: Rec) => r.data as Rec);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);
  const a = admin();

  const isForm = (req.headers.get("content-type") || "").includes("multipart/form-data");
  const form = isForm ? await req.formData() : null;
  const body: Rec = isForm ? Object.fromEntries([...form!.entries()].filter(([, v]) => typeof v === "string")) : await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    if (action === "status") return json({ drive: driveReady(), ai: aiReady() });

    /* ---------- upload ---------- */
    if (action === "upload") {
      if (!driveReady()) return json({ error: "Google Drive is not connected yet. The administrator needs to add the Google keys.", notConfigured: true });
      const p = await loadProject(String(body.project || ""));
      if (!canUse(p, me)) return json({ error: "You are not part of this project." }, 403);
      const file = form!.get("file");
      if (!(file instanceof File)) return json({ error: "No file received." }, 400);
      if (file.size > MAX_BYTES) return json({ error: "This file is larger than 25 MB. Please upload a smaller file." }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || "application/octet-stream";

      const root = await ensureFolder("_root", ROOT_NAME, null);
      const pf = await ensureFolder(`p:${p!.id}`, clean(p!.name, 80) || "Project", root.id);
      const text = await readText(file.name, mime, bytes, pf.id);

      const { data: subs } = await a.from("drive_folders").select("name").like("key", `p:${p!.id}/%`);
      const existing = (subs || []).map((s: Rec) => s.name as string);
      let folder = clean(String(body.folder || ""), 40), name = "", summary = "";
      if (aiReady()) {
        const prompt = `You file documents for a company project.\nProject: ${p!.name}\n${p!.description ? "About: " + p!.description + "\n" : ""}` +
          `Existing folders: ${existing.length ? existing.join(", ") : "(none yet)"}\nToday: ${uaeDate()}\nOriginal file name: ${file.name}\n` +
          `Start of the file's text:\n"""${text.slice(0, 4000) || "(could not read the text)"}"""\n\n` +
          `Reply with JSON only: {"folder": "...", "name": "...", "summary": "..."}\n` +
          `- folder: reuse an existing folder when it fits; otherwise a new short folder name in Title Case (1-3 words), e.g. Contracts, Quotations, Drawings, Invoices, Reports, Correspondence, Photos.\n` +
          `- name: a clear file name WITHOUT the extension: what it is, who/what it is about, and the document's date if it has one (YYYY-MM-DD). Max 80 characters.\n` +
          `- summary: one sentence on what the file contains.`;
        const j = parseJson(await askAI(prompt, 400).catch(() => "")) || {};
        if (!folder) folder = clean(j.folder || "", 40);
        name = clean(j.name || "", 80); summary = String(j.summary || "").slice(0, 300);
      }
      if (!folder) folder = "General";
      const e = ext(file.name);
      const base = name || clean(file.name.replace(/\.[^.]+$/, ""), 80) || "File";
      const finalName = e && !base.toLowerCase().endsWith("." + e) ? `${base}.${e}` : base;
      const match = existing.find((x) => x.toLowerCase() === folder.toLowerCase()); if (match) folder = match;
      const sub = await ensureFolder(`p:${p!.id}/${folder}`, folder, pf.id);
      const up = await uploadBytes({ name: finalName, parents: [sub.id] }, bytes, mime);

      const rec = {
        id: up.id, projectId: p!.id, name: finalName, original: file.name, folder, folderUrl: sub.url, projectFolderUrl: pf.url,
        url: up.webViewLink, mime, size: file.size, by: me.id, at: new Date().toISOString(), summary, readable: !!text,
      };
      await a.from("records").upsert({ collection: "pfiles", id: up.id, data: rec });
      if (text) await a.from("project_file_text").upsert({ file_id: up.id, project_id: p!.id, text });
      return json({ file: rec });
    }

    /* ---------- download / remove ---------- */
    if (action === "download" || action === "remove") {
      const { data } = await a.from("records").select("data").eq("collection", "pfiles").eq("id", String(body.file || "")).maybeSingle();
      const f = data?.data as Rec | undefined;
      const p = f && await loadProject(f.projectId);
      if (!f || !canUse(p, me)) return json({ error: "File not found, or you are not part of this project." }, 404);
      if (!driveReady()) return json({ error: "Google Drive is not connected.", notConfigured: true }, 503);
      if (action === "download") {
        const r = await g(`/files/${f.id}?alt=media&supportsAllDrives=true`);
        return new Response(r.body, { headers: { ...cors, "Content-Type": f.mime || "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` } });
      }
      if (!(f.by === me.id || p!.owner === me.id || ["CEO", "General Manager"].includes(me.role)))
        return json({ error: "Only the person who uploaded it, the project owner, the GM or the CEO can remove this file." }, 403);
      await g(`/files/${f.id}?supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
      await a.from("records").delete().eq("collection", "pfiles").eq("id", f.id);
      await a.from("project_file_text").delete().eq("file_id", f.id);
      return json({ ok: true });
    }

    /* ---------- AI assistant ---------- */
    if (action === "ask") {
      const p = await loadProject(String(body.project || ""));
      if (!canUse(p, me)) return json({ error: "You are not part of this project." }, 403);
      if (!aiReady()) return json({ error: "AI is not set up yet." });
      const q = String(body.question || "").slice(0, 2000).trim();
      if (!q) return json({ error: "Please type a question." }, 400);

      const [{ data: ppl }, files, { data: texts }, { data: chat }, { data: tasks }] = await Promise.all([
        a.from("people").select("id,name,title"),
        projectFiles(p!.id),
        a.from("project_file_text").select("file_id,text").eq("project_id", p!.id),
        a.from("records").select("data").eq("collection", "pchat").filter("data->>projectId", "eq", p!.id),
        a.from("records").select("data").eq("collection", "tasks").filter("data->>projectId", "eq", p!.id),
      ]);
      const nm = Object.fromEntries((ppl || []).map((x: Rec) => [x.id, x.name]));
      const tx: Record<string, string> = Object.fromEntries((texts || []).map((x: Rec) => [x.file_id, x.text]));
      // Most relevant file contents first, up to a size budget.
      const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const score = (f: Rec) => words.reduce((s, w) => s + ((f.name + " " + f.folder + " " + (f.summary || "")).toLowerCase().includes(w) ? 5 : 0)
        + Math.min(5, ((tx[f.id] || "").toLowerCase().split(w).length - 1)), 0);
      const ranked = [...files].sort((x, y) => score(y) - score(x));
      let budget = 120_000, contents = "";
      for (const f of ranked) { const t = tx[f.id]; if (!t || budget <= 0) continue; const part = t.slice(0, Math.min(budget, 40_000)); budget -= part.length; contents += `\n--- [${f.id}] ${f.folder}/${f.name} ---\n${part}\n`; }
      const ms = (p!.milestones || []).map((m: Rec) => `- ${m.title} | owner ${nm[m.owner] || "-"} | ${m.start || "?"} to ${m.due || "?"} | ${m.progress || 0}% done`).join("\n");
      const ts = (tasks || []).map((r: Rec) => r.data).slice(-40).map((t: Rec) => `- ${t.title} (${nm[t.owner] || t.owner}, ${t.priority}, started ${t.startDate}${t.completedOn ? ", completed" : ""})`).join("\n");
      const ch = (chat || []).map((r: Rec) => r.data).sort((x: Rec, y: Rec) => String(x.at).localeCompare(String(y.at))).slice(-30)
        .map((m: Rec) => `${m.ai ? "AI" : nm[m.by] || m.by}: ${m.text}`).join("\n");
      const prompt = `You are the assistant for a company project in the Daily Work Portal. Today is ${uaeDate()} (UAE).\n` +
        `Project: ${p!.name}\nAbout: ${p!.description || "-"}\nOwner: ${nm[p!.owner]}\nMembers: ${(p!.members || []).map((x: string) => nm[x] || x).join(", ")}\n` +
        `Dates: ${p!.start || "?"} to ${p!.end || "?"}\nSchedule:\n${ms || "(no milestones)"}\nLinked tasks:\n${ts || "(none)"}\n` +
        `Files (id | folder/name | summary):\n${files.map((f) => `[${f.id}] ${f.folder}/${f.name} | ${f.summary || ""}`).join("\n") || "(no files)"}\n` +
        `File contents (may be partial):${contents || " (none readable)"}\n\nRecent chat:\n${ch || "(none)"}\n\n` +
        `Question from ${me.name}: ${q}\n\n` +
        `Answer only from the information above. If it is not there, say so plainly; do not guess. Keep it short and practical.\n` +
        `If the person asks for a document or folder, or a file supports your answer, list those file ids.\n` +
        `Reply with JSON only: {"answer": "...", "file_ids": ["..."]}`;
      const raw = await askAI(prompt, 1500);
      const j = parseJson(raw);
      const ids = new Set(files.map((f) => f.id));
      return json({ answer: String(j?.answer || raw).slice(0, 6000), file_ids: (Array.isArray(j?.file_ids) ? j!.file_ids : []).filter((x: string) => ids.has(x)).slice(0, 10) });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error(action, (e as Error).message);
    return json({ error: (e as Error).message }, 502);
  }
});
