// Shared helpers for the portal's server functions.
import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

/** Database client with full rights. Used only inside these functions, never in the browser. */
export function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/** The staff row of the person calling, or null if they are not signed in / not on the staff list. */
export async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const a = admin();
  const { data: { user } } = await a.auth.getUser(jwt);
  if (!user) return null;
  const { data } = await a.from("people").select("*").eq("user_id", user.id).maybeSingle();
  return data;
}

/** Send an email through Resend. Returns quietly if email is not set up yet. */
export async function sendEmail(to: string[], subject: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  to = to.filter(Boolean);
  if (!key || !from || !to.length) return { skipped: true };
  const portal = Deno.env.get("PORTAL_URL");
  const body = text + (portal ? `\n\nOpen the portal: ${portal}` : "") + "\n\n— Daily Work Portal";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: subject.slice(0, 200), text: body }),
  });
  if (!r.ok) console.error("Resend error", r.status, await r.text());
  return { ok: r.ok, status: r.status };
}
