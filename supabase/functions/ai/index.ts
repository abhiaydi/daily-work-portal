// AI for the portal: MoM drafts, meeting prep and the management summary.
// Uses Claude when the secret ANTHROPIC_API_KEY is set; otherwise Google Gemini when GEMINI_API_KEY is set.
// Optional: AI_MODEL (Claude model id), GEMINI_MODEL (Gemini model id).
// Checks the caller's login itself (see common.ts), so the gateway JWT check is off.
import { caller, cors, json } from "../_shared/common.ts";

async function askClaude(key: string, prompt: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("AI_MODEL") || "claude-sonnet-5-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `AI request failed (${r.status}).`);
  return (d.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
}

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
async function geminiGenerate(key: string, model: string, prompt: string) {
  const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}
async function askGemini(key: string, prompt: string) {
  let model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  let res = await geminiGenerate(key, model, prompt);
  if (res.status === 404) {
    // The default model may have been retired: pick an available "flash" model instead.
    const l = await fetch(`${GEMINI}/models`, { headers: { "x-goog-api-key": key } }).then((r) => r.json()).catch(() => ({}));
    const names = (l.models || []).filter((m: { supportedGenerationMethods?: string[] }) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m: { name: string }) => m.name.replace(/^models\//, ""));
    const pick = names.find((n: string) => /flash/.test(n) && !/lite|image|tts|live/.test(n)) || names[0];
    if (pick) { model = pick; res = await geminiGenerate(key, model, prompt); }
  }
  if (!res.ok) throw new Error(res.d?.error?.message || `AI request failed (${res.status}).`);
  const parts = res.d?.candidates?.[0]?.content?.parts || [];
  return parts.map((p: { text?: string }) => p.text || "").join("").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);

  const { prompt } = await req.json().catch(() => ({}));
  if (!prompt || typeof prompt !== "string") return json({ error: "Nothing to send to the AI." }, 400);
  const text = prompt.slice(0, 20000);

  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY"), geminiKey = Deno.env.get("GEMINI_API_KEY");
  try {
    if (claudeKey) return json({ text: await askClaude(claudeKey, text), provider: "claude" });
    if (geminiKey) return json({ text: await askGemini(geminiKey, text), provider: "gemini" });
    return json({ error: "AI is not set up yet. The administrator needs to add an AI key." });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
