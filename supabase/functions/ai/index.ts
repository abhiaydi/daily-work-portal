// AI for the portal: MoM drafts, meeting prep and the management summary.
// Uses Claude when the secret ANTHROPIC_API_KEY is set; otherwise Google Gemini when GEMINI_API_KEY is set.
// Optional: AI_MODEL (Claude model id), GEMINI_MODEL (Gemini model id).
// Checks the caller's login itself (see common.ts), so the gateway JWT check is off.
import { aiReady, askAI, caller, cors, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);

  const { prompt } = await req.json().catch(() => ({}));
  if (!prompt || typeof prompt !== "string") return json({ error: "Nothing to send to the AI." }, 400);
  const text = prompt.slice(0, 20000);

  if (!aiReady()) return json({ error: "AI is not set up yet. The administrator needs to add an AI key." });
  try {
    return json({ text: await askAI(text) });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
