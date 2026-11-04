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
  to = to.filter((e) => e && e.includes("@") && !/CHANGE-ME/i.test(e));   // skip placeholder addresses
  if (!key || !from || !to.length) return { skipped: true };
  const portal = Deno.env.get("PORTAL_URL") || "https://abhiaydi.github.io/daily-work-portal/";
  const body = text + (portal ? `\n\nOpen the portal: ${portal}` : "") + "\n\n— Daily Work Portal";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: subject.slice(0, 200), text: body }),
  });
  if (!r.ok) console.error("Resend error", r.status, await r.text());
  return { ok: r.ok, status: r.status };
}

/* ===== AI: Claude when ANTHROPIC_API_KEY is set, otherwise Google Gemini (GEMINI_API_KEY) ===== */
async function askClaude(key: string, prompt: string, maxTokens: number) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("AI_MODEL") || "claude-sonnet-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `AI request failed (${r.status}).`);
  return (d.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
}

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
async function geminiGenerate(key: string, model: string, prompt: string, maxTokens: number) {
  const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
async function askGemini(key: string, prompt: string, maxTokens: number) {
  let model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  let res = await geminiGenerate(key, model, prompt, maxTokens);
  if (res.status === 404) {
    // The default model may have been retired: pick an available "flash" model instead.
    const l = await fetch(`${GEMINI}/models`, { headers: { "x-goog-api-key": key } }).then((r) => r.json()).catch(() => ({}));
    const names = (l.models || []).filter((m: { supportedGenerationMethods?: string[] }) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m: { name: string }) => m.name.replace(/^models\//, ""));
    const pick = names.find((n: string) => /flash/.test(n) && !/lite|image|tts|live/.test(n)) || names[0];
    if (pick) { model = pick; res = await geminiGenerate(key, model, prompt, maxTokens); }
  }
  if (!res.ok) throw new Error(res.d?.error?.message || `AI request failed (${res.status}).`);
  const parts = res.d?.candidates?.[0]?.content?.parts || [];
  return parts.map((p: { text?: string }) => p.text || "").join("").trim();
}

/** Ask the AI. Throws if no AI key is set or the request fails. */
export async function askAI(prompt: string, maxTokens = 1500): Promise<string> {
  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY"), geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (claudeKey) return await askClaude(claudeKey, prompt, maxTokens);
  if (geminiKey) return await askGemini(geminiKey, prompt, Math.max(maxTokens, 2048));
  throw new Error("AI is not set up yet. The administrator needs to add an AI key.");
}
export const aiReady = () => !!(Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("GEMINI_API_KEY"));
