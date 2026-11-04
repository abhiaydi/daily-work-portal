// Place search and driving times for meetings.
// With the secret GOOGLE_MAPS_API_KEY: Google Places Autocomplete + Google Routes (live traffic).
// Without it: free OpenStreetMap services: Photon (komoot) for place search and the public OSRM server for
// driving routes. OSM has no live traffic, so a time-of-day traffic allowance is added.
// Actions (POST, logged-in staff only):
//   suggest { q }                      -> { items: [{ label, sub, lat?, lng?, placeId? }], provider }
//   route   { from, to, depart }       -> { minutes, km, note, provider }
//            from/to: { label, lat?, lng?, placeId? } or a text; depart: ISO time
import { admin, caller, cors, json } from "../_shared/common.ts";

const UA = "DailyWorkPortal/1.0 (company staff portal)";
const UAE_BBOX = "51.5,22.6,56.5,26.1";   // lon,lat,lon,lat
type P = { label: string; lat?: number; lng?: number; placeId?: string };
const asPlace = (x: unknown): P => typeof x === "string" ? { label: x } : (x as P) || { label: "" };

/* ---------- Google ---------- */
async function gSuggest(key: string, q: string) {
  const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({ input: q, includedRegionCodes: ["ae", "sa", "om"], locationBias: { circle: { center: { latitude: 25.2, longitude: 55.3 }, radius: 50000 } } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Google ${r.status}`);
  return (d.suggestions || []).filter((s: any) => s.placePrediction).slice(0, 6).map((s: any) => ({
    label: s.placePrediction.structuredFormat?.mainText?.text || s.placePrediction.text?.text,
    sub: s.placePrediction.structuredFormat?.secondaryText?.text || "",
    placeId: s.placePrediction.placeId,
  }));
}
function gWaypoint(p: P) {
  if (p.placeId) return { placeId: p.placeId };
  if (isFinite(p.lat as number) && isFinite(p.lng as number)) return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
  return { address: p.label };
}
async function gRoute(key: string, from: P, to: P, depart: string) {
  const dep = new Date(depart); const future = dep.getTime() > Date.now() + 60_000;
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
    body: JSON.stringify({ origin: gWaypoint(from), destination: gWaypoint(to), travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", ...(future ? { departureTime: dep.toISOString() } : {}) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.routes?.length) throw new Error(d?.error?.message || "No route found");
  const sec = parseInt(String(d.routes[0].duration || "0").replace("s", ""), 10), km = Math.round((d.routes[0].distanceMeters || 0) / 1000);
  return { minutes: Math.round(sec / 60) + 10, km, note: `About ${km} km by road; Google Maps traffic estimate${future ? " for that time" : ""}, plus 10 min to park.` };
}

/* ---------- OpenStreetMap (free) ---------- */
const CACHE = new Map<string, any[]>();
async function oSearch(q: string, limit = 6) {
  const key = q.toLowerCase() + "|" + limit; if (CACHE.has(key)) return CACHE.get(key)!;
  // One request, biased towards Dubai (places nearby rank first); Gulf results are moved to the top.
  const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit + 4}&lang=en&lat=25.2&lon=55.3&location_bias_scale=0.3`;
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
  const d = await fetch(u, { headers: { "User-Agent": UA }, signal: ctl.signal }).then((r) => r.json()).catch(() => ({})).finally(() => clearTimeout(tm));
  const gulf = (f: any) => /United Arab Emirates|Saudi Arabia|Oman|Qatar|Bahrain|Kuwait/.test(f.properties?.country || "") ? 0 : 1;
  d.features = (d.features || []).sort((x: any, y: any) => gulf(x) - gulf(y));
  const seen = new Set<string>();
  const out = (d.features || []).map((f: any) => {
    const p = f.properties || {}, [lng, lat] = f.geometry?.coordinates || [];
    const label = p.name || [p.street, p.housenumber].filter(Boolean).join(" ") || p.city || "";
    const sub = [p.district || p.locality, p.city !== label ? p.city : "", p.state !== p.city ? p.state : "", p.country].filter(Boolean).join(", ");
    return { label, sub, lat, lng };
  }).filter((x: any) => x.label && isFinite(x.lat) && !seen.has(x.label + x.sub) && seen.add(x.label + x.sub)).slice(0, limit);
  if (out.length) { CACHE.set(key, out); if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value!); }
  return out;
}
async function oLocate(p: P): Promise<P> {
  if (isFinite(p.lat as number) && isFinite(p.lng as number)) return p;
  const hit = (await oSearch(p.label, 1))[0];
  if (!hit) throw new Error(`Could not find "${p.label}" on the map`);
  return { label: p.label, lat: hit.lat, lng: hit.lng };
}
function trafficAllowance(depart: string) {
  const d = new Date(new Date(depart).getTime() + 4 * 3600_000);   // UAE time
  const h = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();   // 0 Sun ... 6 Sat
  const weekday = wd >= 1 && wd <= 5;
  if (weekday && ((h >= 7 && h < 9.5) || (h >= 17 && h < 20))) return { f: 1.45, why: "weekday rush hour" };
  if (weekday && h >= 9.5 && h < 17) return { f: 1.2, why: "daytime traffic" };
  return { f: 1.1, why: "light traffic" };
}
async function oRoute(fromIn: P, toIn: P, depart: string) {
  const [a, b] = await Promise.all([oLocate(fromIn), oLocate(toIn)]);
  const u = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
  const d = await fetch(u, { headers: { "User-Agent": UA } }).then((r) => r.json()).catch(() => ({}));
  if (d.code !== "Ok" || !d.routes?.length) throw new Error("No driving route found");
  const base = d.routes[0].duration / 60, km = Math.round(d.routes[0].distance / 1000), t = trafficAllowance(depart);
  const minutes = Math.round(base * t.f) + 10;
  return { minutes, km, note: `About ${km} km by road (OpenStreetMap). ${Math.round(base)} min without traffic; allowed extra for ${t.why}, plus 10 min to park.` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  // Administrator test with the scheduler secret; otherwise a logged-in staff member is required.
  let ok = false;
  if (req.headers.get("x-cron-secret")) { const { data } = await admin().rpc("check_cron_secret", { s: req.headers.get("x-cron-secret") }); ok = data === true; }
  if (!ok && !(await caller(req))) return json({ error: "Please log in again." }, 401);
  const gKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (body.action === "diag" && ok) {
    const t0 = Date.now(); const r1 = await fetch(`https://photon.komoot.io/api/?q=dubai%20marina&limit=6&lang=en&lat=25.2&lon=55.3`, { headers: { "User-Agent": UA } });
    const t1 = Date.now(); await r1.text();
    const r2 = await fetch(`https://photon.komoot.io/api/?q=dubai%20marina&limit=6&lang=en&lat=25.2&lon=55.3&bbox=${UAE_BBOX}`, { headers: { "User-Agent": UA, Origin: "https://abhiaydi.github.io" } });
    const t2 = Date.now(); await r2.text();
    const t3 = Date.now(); await admin().auth.getUser("x").catch(() => null); const t4 = Date.now();
    return json({ photon1: t1 - t0, photon2: t2 - t1, auth: t4 - t3, cors: r2.headers.get("access-control-allow-origin"), status: r2.status });
  }
  try {
    if (body.action === "suggest") {
      const q = String(body.q || "").trim().slice(0, 120);
      if (q.length < 2) return json({ items: [] });
      if (gKey) { try { return json({ items: await gSuggest(gKey, q), provider: "google" }); } catch (e) { console.error("google suggest:", (e as Error).message); } }
      return json({ items: await oSearch(q), provider: "osm" });
    }
    if (body.action === "route") {
      const from = asPlace(body.from), to = asPlace(body.to), depart = String(body.depart || new Date().toISOString());
      if (!from.label || !to.label) return json({ error: "Both places are needed." }, 400);
      if (gKey) { try { return json({ ...(await gRoute(gKey, from, to, depart)), provider: "google" }); } catch (e) { console.error("google route:", (e as Error).message); } }
      return json({ ...(await oRoute(from, to, depart)), provider: "osm" });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message });
  }
});
