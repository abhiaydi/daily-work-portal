// Meeting reminder emails. Called every minute by the database scheduler (see supabase/cron.sql).
//  - 24 h, 12 h, 6 h, 1 h, 15 min and 10 min before each meeting
//  - "notes missing" every 30 minutes (09:00–22:00 UAE) from the morning after the meeting,
//    or 30 minutes after a MoM is sent back, until the salesperson writes it
//  - cancelled meetings: one follow-up reminder (portal notification + email) 7 days later if not rebooked
// The scheduler sends a secret in the x-cron-secret header; it is checked against the database
// (private.settings, readable only by the server).
import { admin, json, sendEmail } from "../_shared/common.ts";

const OFFSETS = [1440, 720, 360, 60, 15, 10];        // minutes before
const LATE_WINDOW = 30 * 60_000;                     // don't send reminders that are more than 30 min stale
const NAG_EVERY = 30 * 60_000;
const EPOCH = Date.parse("2020-01-01T00:00:00+04:00"); // the portal stores some times as minutes since this
const startMs = (m: Rec) => Date.parse(`${m.date}T${m.time}:00+04:00`);
const absToMs = (a: number) => EPOCH + a * 60_000;
const uaeMinutes = (ms: number) => Math.floor(((ms + 4 * 3_600_000) % 86_400_000) / 60_000);
const nextDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
const label = (o: number) => (o >= 60 ? `${o / 60} hour${o === 60 ? "" : "s"}` : `${o} minutes`);
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
type Rec = Record<string, any>;

Deno.serve(async (req) => {
  const a = admin();
  const { data: ok } = await a.rpc("check_cron_secret", { s: req.headers.get("x-cron-secret") || "" });
  if (ok !== true) return json({ error: "forbidden" }, 403);

  const now = Date.now();
  const [{ data: rows }, { data: people }] = await Promise.all([
    a.from("records").select("id,data").eq("collection", "meetings"),
    a.from("people").select("id,email"),
  ]);
  const email: Record<string, string> = Object.fromEntries((people || []).map((p: Rec) => [p.id, p.email]));
  let sent = 0;

  const all: Rec[] = (rows || []).map((r: Rec) => r.data).filter(Boolean);
  const nowAbs = Math.floor((now - EPOCH) / 60_000);
  for (const r of rows || []) {
    const m: Rec = r.data;
    if (!m || !m.date || !m.time) continue;
    // Cancelled meeting: one follow-up reminder 7 days later if no new meeting with the same person was booked.
    if (m.status === "cancelled" && m.followUpAt && now >= absToMs(m.followUpAt) && !(m.emailSent || {}).followUp) {
      const who = String(m.withWhom || "").trim().toLowerCase();
      const rebooked = m.rebookedTo || all.some((x) => x.owner === m.owner && x.id !== m.id && x.status !== "cancelled" && (x.createdAt || 0) > (m.cancelledAt || 0) && String(x.withWhom || "").trim().toLowerCase() === who);
      const es2: Rec = { ...(m.emailSent || {}), followUp: rebooked ? "rebooked" : new Date(now).toISOString() };
      if (!rebooked) {
        const text = `Reminder: your meeting with ${m.withWhom} was cancelled 7 days ago (${m.cancelReason || "no reason given"}) and no new meeting has been booked. Please follow up and schedule it.`;
        const nid = "fu-" + m.id;
        await a.from("records").upsert({ collection: "notifications", id: nid, data: { id: nid, owner: m.owner, text, at: nowAbs, meetingId: m.id, read: false, email: true } });
        if (email[m.owner]) await sendEmail([email[m.owner]], `Follow up: meeting with ${m.withWhom}`, text);
        sent++;
      }
      await a.rpc("set_email_sent", { mid: r.id, sent: es2 });
      continue;
    }
    const to = email[m.owner];
    if (!to) continue;
    const st = startMs(m);
    const es: Rec = { ...(m.emailSent || {}) };
    let changed = false;
    const when = fmt.format(new Date(st));

    if (m.status === "scheduled") {
      for (const o of OFFSETS) {
        const k = "pre" + o, t = st - o * 60_000;
        if (es[k] || now < t) continue;
        if (t < absToMs(m.createdAt || 0) || now - t > LATE_WINDOW) { es[k] = "skipped"; changed = true; continue; }
        await sendEmail([to], `Reminder: meeting with ${m.withWhom} in ${label(o)}`,
          `Your meeting with ${m.withWhom} is at ${when} (UAE time).\nPurpose: ${m.purpose}${m.place ? `\nPlace: ${m.place}` : ""}`);
        es[k] = new Date(now).toISOString(); changed = true; sent++;
      }
    }

    const needsNotes = (m.status === "scheduled" && now >= st) || m.status === "returned";
    if (needsNotes) {
      const begin = m.status === "returned" ? absToMs(m.returnedAt || 0) + NAG_EVERY : Date.parse(`${nextDay(m.date)}T09:00:00+04:00`);
      const um = uaeMinutes(now), last = es.lastNag ? Date.parse(es.lastNag) : 0;
      if (now >= begin && um >= 9 * 60 && um <= 22 * 60 && now - last >= NAG_EVERY - 60_000) {
        await sendEmail([to], m.status === "returned" ? `Action needed: add detail to your MoM (${m.withWhom})` : `Action needed: MoM missing for your meeting with ${m.withWhom}`,
          m.status === "returned"
            ? `Your minutes for the meeting with ${m.withWhom} (${when}) were sent back. Please add more detail in the portal.`
            : `You have not written the minutes for your meeting with ${m.withWhom} (${when}). Please write them in the portal. This reminder repeats every 30 minutes until it is done.`);
        es.lastNag = new Date(now).toISOString(); changed = true; sent++;
      }
    }

    if (changed) await a.rpc("set_email_sent", { mid: r.id, sent: es });
  }
  return json({ ok: true, sent });
});
