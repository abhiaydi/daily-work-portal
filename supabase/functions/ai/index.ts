// AI for the portal: MoM drafts, meeting prep and the management summary.
// Needs the secret ANTHROPIC_API_KEY. Optional: AI_MODEL (defaults below).
import { caller, cors, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI is not set up yet. The administrator needs to add the ANTHROPIC_API_KEY secret." });

  const { prompt } = await req.json().catch(() => ({}));
  if (!prompt || typeof prompt !== "string") return json({ error: "Nothing to send to the AI." }, 400);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("AI_MODEL") || "claude-sonnet-5-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt.slice(0, 20000) }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: d?.error?.message || `AI request failed (${r.status}).` }, 502);
  const text = (d.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
  return json({ text });
});
