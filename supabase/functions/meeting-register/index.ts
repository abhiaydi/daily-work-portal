// Full meeting register (Excel), built on the server.
//   download { month: "YYYY-MM" | "all", who? }  -> { name, b64 }   only the meetings the caller may see:
//        their own, their team's (as direct manager / meeting reviewer), everyone's for the CEO and GM.
//   refresh  (scheduler secret)                  -> stores the company-wide register in the private bucket
//        "registers": meeting-register-latest.xlsx and meeting-register-YYYY-MM.xlsx (current month).
// Meeting check-in locations are included only in the CEO/GM version.
import * as XLSX from "npm:xlsx@0.18.5";
import { admin, caller, cors, json } from "../_shared/common.ts";

type Rec = Record<string, any>;
const EPOCH = Date.parse("2020-01-01T00:00:00+04:00");
const absTxt = (a?: number) => a ? new Date(EPOCH + a * 60_000).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";
const addMin = (t: string, mins: number) => { const [h, m] = t.split(":").map(Number); const x = h * 60 + m + mins; return `${String(Math.floor(x / 60) % 24).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const durTxt = (m: Rec) => m.allDay ? "Whole day" : (m.dur || 60) < 60 ? `${m.dur} min` : `${(m.dur || 60) / 60} h`;
const MGMT = ["CEO", "General Manager"];

function statusTxt(m: Rec, nowMs: number) {
  if (m.status === "deleted") return "Deleted";
  if (m.status === "cancelled") return "Cancelled";
  if (m.status === "approved") return m.outcome === "postponed" ? "Postponed (approved)" : "Held (approved)";
  if (m.status === "review") return m.outcome === "postponed" ? "Postponed (awaiting approval)" : "Held (awaiting approval)";
  if (m.status === "returned") return "Sent back for more detail";
  return Date.parse(`${m.date}T${m.time}:00+04:00`) > nowMs ? "Upcoming" : "Minutes not written yet";
}

function build(meetings: Rec[], people: Rec[], full: boolean, locs: Record<string, Rec>) {
  const nm: Record<string, Rec> = Object.fromEntries(people.map((p) => [p.id, p]));
  const name = (id: string) => nm[id]?.name || id || "";
  const now = Date.now();
  const rows = meetings.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map((m) => {
    const appr = (m.history || []).filter((h: Rec) => h.action !== "submitted").map((h: Rec) => `${h.action === "approved" ? "Approved" : "Sent back"} by ${name(h.by)} on ${absTxt(h.at)}${h.text ? ": " + h.text : ""}`).join("\n");
    const resched = (m.resched || []).map((r: Rec) => `Moved on ${absTxt(r.at)} from ${r.from?.date} ${r.from?.allDay ? "(whole day)" : r.from?.time}${r.from?.place && r.from.place !== m.place ? " at " + r.from.place : ""}${r.reason ? " — " + r.reason : ""}`).join("\n");
    const diary = (m.diary || []).map((d: Rec) => `${absTxt(d.t)}: ${d.text}`).join("\n");
    const geoQ = m.placeGeo?.lat != null ? `${m.placeGeo.lat},${m.placeGeo.lng}` : m.place;
    const row: Rec = {
      "Date": m.date, "Start": m.allDay ? "" : m.time, "End": m.allDay ? "" : addMin(m.time, m.dur || 60), "Duration": durTxt(m),
      "Employee": name(m.owner), "Title": nm[m.owner]?.title || "", "Meeting with": m.withWhom || "", "Purpose": m.purpose || "",
      "Type": m.mode === "online" ? "Online" : "In person", "Place": m.place || "",
      "Map": m.mode === "online" || !m.place ? "" : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(geoQ)}`,
      "Status": statusTxt(m, now),
      "Minutes of meeting (full)": m.outcome === "postponed" ? "" : (m.notes || ""),
      "Postponed: reason": m.outcome === "postponed" ? (m.postponeReason || "") : "",
      "MoM in brief (AI)": m.momBrief || "",
      "Diary notes during the meeting": diary,
      "MoM submitted": absTxt(m.notesAt),
      "Approvals / sent back": appr,
      "Rescheduled": resched,
      "Cancelled on": absTxt(m.cancelledAt), "Cancellation reason": m.cancelReason || "",
      "Deleted on": absTxt(m.deletedAt), "Deleted by": m.deletedBy ? name(m.deletedBy) : "", "Deletion reason": m.deleteReason || "",
      "Follow-up": m.status === "cancelled" ? (m.rebookedTo ? "New meeting booked" : "Not rebooked yet") : "",
      "Scheduled on": absTxt(m.createdAt),
    };
    if (full) {
      const g = m.geo, l = locs[m.id];
      row["Check-in at meeting"] = g ? `${g.time || ""}${g.auto ? " (automatic)" : ""}` : "";
      row["Check-in location"] = l && l.lat != null ? `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}` : "";
    }
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "Date": "No meetings for this selection" }]);
  const widths = [11, 7, 7, 10, 20, 22, 24, 30, 10, 28, 20, 22, 70, 40, 45, 50, 18, 45, 45, 18, 35, 18, 20, 40, 18, 14, 22];
  ws["!cols"] = Object.keys(rows[0] || { a: 1 }).map((_, i) => ({ wch: widths[i] || 18 }));
  ws["!autofilter"] = { ref: ws["!ref"] || "A1" };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Meetings");
  // Summary by person
  const by: Record<string, Rec> = {};
  meetings.forEach((m) => { const k = name(m.owner); const s = by[k] = by[k] || { "Employee": k, "Meetings": 0, "Held": 0, "Postponed": 0, "Cancelled": 0, "Deleted": 0, "Upcoming / notes due": 0 };
    s["Meetings"]++; if (m.status === "deleted") s["Deleted"]++; else if (m.status === "cancelled") s["Cancelled"]++; else if (m.outcome === "postponed") s["Postponed"]++; else if (m.outcome === "held") s["Held"]++; else s["Upcoming / notes due"]++; });
  const ss = XLSX.utils.json_to_sheet(Object.values(by).length ? Object.values(by) : [{ "Employee": "—" }]);
  ss["!cols"] = [{ wch: 24 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ss, "By person");
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
}
const b64bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const a = admin();
  const body = await req.json().catch(() => ({}));
  const [{ data: rows }, { data: people }] = await Promise.all([
    a.from("records").select("data").eq("collection", "meetings"),
    a.from("people").select("id,name,title,role,managers"),
  ]);
  const all: Rec[] = (rows || []).map((r: Rec) => r.data).filter((m: Rec) => m && m.date && m.time);
  const ppl: Rec[] = people || [];
  const locRows = async (ids: string[]) => {
    if (!ids.length) return {};
    const { data } = await a.from("locations").select("ref,lat,lng").in("ref", ids.slice(0, 1000));
    return Object.fromEntries((data || []).map((l: Rec) => [l.ref, l]));
  };

  if (body.action === "refresh") {
    const { data: ok } = await a.rpc("check_cron_secret", { s: req.headers.get("x-cron-secret") || "" });
    if (ok !== true) return json({ error: "forbidden" }, 403);
    const locs = await locRows(all.filter((m) => m.geo).map((m) => m.id));
    const month = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 7);
    const up = async (path: string, list: Rec[]) => {
      const { error } = await a.storage.from("registers").upload(path, b64bytes(build(list, ppl, true, locs)), { upsert: true, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      if (error) throw error;
    };
    try { await up("meeting-register-latest.xlsx", all); await up(`meeting-register-${month}.xlsx`, all.filter((m) => m.date.startsWith(month))); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
    return json({ ok: true, meetings: all.length });
  }

  if (body.action === "download") {
    const me = await caller(req);
    if (!me) return json({ error: "Please log in again." }, 401);
    const mgmt = MGMT.includes(me.role);
    // Who reviews whose meetings (same rules as the portal): sales staff -> CEO/GM; others -> direct managers.
    const visible = (m: Rec) => {
      if (mgmt || m.owner === me.id) return true;
      const o = ppl.find((p) => p.id === m.owner);
      return !!o && (o.managers || []).includes(me.id);
    };
    const month = String(body.month || "all"), who = String(body.who || "");
    const list = all.filter((m) => visible(m) && (month === "all" || m.date.startsWith(month)) && (!who || m.owner === who));
    const locs = mgmt ? await locRows(list.filter((m) => m.geo).map((m) => m.id)) : {};
    const tag = month === "all" ? "all" : month;
    return json({ name: `meeting-register-${tag}${who ? "-" + who : ""}.xlsx`, b64: build(list, ppl, mgmt, locs) });
  }
  return json({ error: "Unknown action." }, 400);
});
