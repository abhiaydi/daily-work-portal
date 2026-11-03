// Meeting reminder emails. Called every minute by the database scheduler (see supabase/cron.sql).
//  - 24 h, 12 h, 6 h, 1 h, 15 min and 10 min before each meeting
//  - "notes missing" every 30 minutes (09:00–22:00 UAE) from the morning after the meeting,
//    or 30 minutes after a MoM is sent back, until the salesperson writes it
// Needs the secret CRON_SECRET (the scheduler sends it in the x-cron-secret header).
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
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);

  const a = admin();
  const now = Date.now();
  const [{ data: rows }, { data: people }] = await Promise.all([
    a.from("records").select("id,data").eq("collection", "meetings"),
    a.from("people").select("id,email"),
  ]);
  const email: Record<string, string> = Object.fromEntries((people || []).map((p: Rec) => [p.id, p.email]));
  let sent = 0;

  for (const r of rows || []) {
    const m: Rec = r.data;
    if (!m || !m.date || !m.time) continue;
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
