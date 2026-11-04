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
async function geminiGenerate(key: string, model: string, prompt: string, maxTokens: number, json = false) {
  const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) } }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
let geminiModel = "";   // the model that last worked (remembered while the function stays warm)
async function geminiModels(key: string): Promise<string[]> {
  const l = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": key } }).then((r) => r.json()).catch(() => ({}));
  const names: string[] = (l.models || []).filter((m: { supportedGenerationMethods?: string[] }) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: { name: string }) => m.name.replace(/^models\//, ""));
  const ver = (n: string) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  const rank = (n: string) => (/flash/.test(n) ? 0 : 2) + (/lite/.test(n) ? 1 : 0) + (/preview|exp/.test(n) ? 0.5 : 0);
  return names.filter((n) => /^gemini/.test(n) && !/image|tts|live|audio|embedding|robotics|computer/.test(n))
    .sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a));
}
async function askGemini(key: string, prompt: string, maxTokens: number, json = false) {
  const first = geminiModel || Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  let res = await geminiGenerate(key, first, prompt, maxTokens, json);
  if (res.status === 429 || res.status === 503) { await new Promise((r) => setTimeout(r, 2000)); res = await geminiGenerate(key, first, prompt, maxTokens, json); }
  if (res.ok) geminiModel = first;
  else if (res.status === 404 || res.status === 400) {
    // The model may have been retired: try the newest available "flash" models instead.
    for (const m of (await geminiModels(key)).filter((x) => x !== first).slice(0, 5)) {
      res = await geminiGenerate(key, m, prompt, maxTokens, json);
      if (res.ok) { geminiModel = m; console.log("Gemini model in use:", m); break; }
    }
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${res.d?.error?.message || "request failed"}`);
  const parts = res.d?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || "").join("").trim();
}

/** Ask the AI. Throws if no AI key is set or the request fails. */
export async function askAI(prompt: string, maxTokens = 1500, json = false): Promise<string> {
  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY"), geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (claudeKey) return await askClaude(claudeKey, prompt, maxTokens);
  if (geminiKey) return await askGemini(geminiKey, prompt, Math.max(maxTokens, 8192), json);   // room for Gemini's thinking tokens
  throw new Error("AI is not set up yet. The administrator needs to add an AI key.");
}
export const aiModelInUse = () => geminiModel;
export const aiReady = () => !!(Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("GEMINI_API_KEY"));
