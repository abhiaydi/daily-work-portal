// AI for the portal: MoM drafts, meeting prep and the management summary.
// Uses Claude when the secret ANTHROPIC_API_KEY is set; otherwise Google Gemini when GEMINI_API_KEY is set.
// Optional: AI_MODEL (Claude model id), GEMINI_MODEL (Gemini model id).
// Checks the caller's login itself (see common.ts), so the gateway JWT check is off.
import { admin, aiModelInUse, aiReady, askAI, caller, cors, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  // Health check for the administrator: the scheduler secret is required.
  if (body.health) {
    const { data: ok } = await admin().rpc("check_cron_secret", { s: req.headers.get("x-cron-secret") || "" });
    if (ok !== true) return json({ error: "forbidden" }, 403);
    try { const reply = typeof body.test === "string" ? await askAI(body.test.slice(0, 20000), 1500, body.json === true) : (await askAI("Reply with the single word OK.", 50)).slice(0, 50); return json({ ok: true, reply, model: aiModelInUse() }); }
    catch (e) { return json({ ok: false, error: (e as Error).message }); }
  }
  const me = await caller(req);
  if (!me) return json({ error: "Please log in again." }, 401);

  const { prompt } = body;
  if (!prompt || typeof prompt !== "string") return json({ error: "Nothing to send to the AI." }, 400);
  const text = prompt.slice(0, 20000);

  if (!aiReady()) return json({ error: "AI is not set up yet. The administrator needs to add an AI key." });
  try {
    return json({ text: await askAI(text, 1500, body.json === true) });
  } catch (e) {
    console.error("ai error:", (e as Error).message);
    return json({ error: (e as Error).message });
  }
});
