// Staff logins, for the CEO and General Manager only.
//  list   -> who already has a login, who is ready (has a real email), who has no email yet
//  create -> creates logins. First password = the person's phone number (digits only, e.g. 971501234567),
//            or a random one if no phone is on file. Everyone must choose their own password at first login.
//  reset  -> sets the first password again (same rule) and asks them to choose a new one
// Checks the caller's login itself (see common.ts), so the gateway JWT check is off.
import { admin, caller, cors, json } from "../_shared/common.ts";

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const tempPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => CHARS[x % CHARS.length]).join("");
const validEmail = (e: string | null) => !!e && e.includes("@") && !/CHANGE-ME/i.test(e);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const me = await caller(req);
  if (!me || !["CEO", "General Manager"].includes(me.role)) return json({ error: "Only the CEO or General Manager can manage logins." }, 403);

  const a = admin();
  const body = await req.json().catch(() => ({}));
  const { data: people } = await a.from("people").select("id,name,role,email,phone");
  const { data: list } = await a.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const byEmail = new Map((list?.users || []).map((u) => [String(u.email).toLowerCase(), u]));
  const hasLogin = (e: string | null) => !!e && byEmail.has(e.toLowerCase());

  if (body.action === "list") {
    return json({ people: (people || []).map((p) => ({ id: p.id, emailOk: validEmail(p.email), hasLogin: hasLogin(p.email) })) });
  }

  if (body.action === "create" || body.action === "reset") {
    const results = [];
    for (const id of (Array.isArray(body.ids) ? body.ids : []).slice(0, 60)) {
      const p = (people || []).find((x) => x.id === id);
      if (!p || !validEmail(p.email)) { results.push({ id, error: "No valid email" }); continue; }
      if (p.id === me.id) { results.push({ id, error: "Change your own password from My account" }); continue; }
      const existing = byEmail.get(p.email.toLowerCase());
      const digits = String(p.phone || "").replace(/\D/g, "");
      const password = digits.length >= 8 ? digits : tempPassword();
      const meta = { user_metadata: { must_change_password: true } };
      if (body.action === "create") {
        if (existing) { results.push({ id, error: "Already has a login" }); continue; }
        const { error } = await a.auth.admin.createUser({ email: p.email, password, email_confirm: true, ...meta });
        results.push(error ? { id, error: error.message } : { id, password, phone: digits.length >= 8 });
      } else {
        if (!existing) { results.push({ id, error: "No login yet" }); continue; }
        if (p.role === "CEO" && me.role !== "CEO") { results.push({ id, error: "Only the CEO can reset the CEO's password" }); continue; }
        const { error } = await a.auth.admin.updateUserById(existing.id, { password, ...meta });
        results.push(error ? { id, error: error.message } : { id, password, phone: digits.length >= 8 });
      }
    }
    return json({ results });
  }
  return json({ error: "Unknown action" }, 400);
});
