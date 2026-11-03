// Sends an email to staff members when something happens in the portal
// (task assigned, closure report submitted or reviewed, MoM submitted / approved / sent back).
import { admin, caller, cors, json, sendEmail } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);

  const { to, subject, text } = await req.json().catch(() => ({}));
  if (!Array.isArray(to) || !to.length || !subject || !text) return json({ error: "Missing recipients or message." }, 400);

  const { data: people } = await admin().from("people").select("id,email").in("id", to.slice(0, 50));
  const emails = (people || []).map((p: { email: string | null }) => p.email).filter(Boolean) as string[];
  const res = await sendEmail(emails, String(subject), `${String(text).slice(0, 8000)}\n\nFrom: ${me.name}`);
  return json({ sent: emails.length, ...res });
});
