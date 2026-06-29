// ─────────────────────────────────────────────────────────────────────────────
// Stock Explorer — Cloudflare Worker proxy + shared chain library
//
// Routes (all on the same Worker URL):
//   POST /          → proxy a request to Anthropic          (gated by ACCESS_PASSWORD)
//   GET/POST /library  → shared chain library (save/delete)  (gated by ACCESS_PASSWORD)
//   GET/POST /glossary → shared saved-glossary library       (gated by ACCESS_PASSWORD)
//
// Your Anthropic key is held server-side and never reaches any browser.
//
// Set in the Cloudflare dashboard → your Worker → Settings:
//   Secrets (Variables and Secrets):
//     ANTHROPIC_API_KEY  — your Anthropic key (sk-ant-...)
//     ACCESS_PASSWORD    — shared password to use the app, open saved chains, and save chains
//   Binding (KV namespace binding):
//     Variable name: LIBRARY   →  bind to your KV namespace
//   (optional) Plaintext variable:
//     ALLOWED_ORIGIN     — your site origin; defaults to the GitHub Pages site below
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ORIGIN = "https://alistairmccreadie-bot.github.io";
// KV holds one JSON-blob map per collection: /library → "chains", /glossary → "glossary".
const COLLECTIONS = { "/library": "chains", "/glossary": "glossary" };

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-access-code",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    // ACCESS_PASSWORD gates everything (use + read).
    const expected = (env.ACCESS_PASSWORD || "").trim();
    if (!expected) return json({ error: { message: "Server has no ACCESS_PASSWORD secret. Add it under Settings → Variables and Secrets, then Deploy." } }, 500, cors);
    const accessOk = (request.headers.get("x-access-code") || "").trim() === expected;

    // ── Collection routes (shared chain library + glossary) ─────────────────────
    if (COLLECTIONS[path]) {
      if (!env.LIBRARY) return json({ error: { message: "Server has no LIBRARY KV binding. Create a KV namespace and bind it as LIBRARY, then Deploy." } }, 500, cors);
      if (!accessOk) return json({ error: { message: "Wrong access password." } }, 401, cors);
      const kvKey = COLLECTIONS[path];

      if (request.method === "GET") {
        return json({ entries: sortEntries(await readMap(env, kvKey)) }, 200, cors);
      }
      if (request.method === "POST") {
        let payload;
        try { payload = JSON.parse(await request.text()); } catch { return json({ error: { message: "Bad request body" } }, 400, cors); }
        const map = await readMap(env, kvKey);
        if (payload.action === "save" && payload.entry) {
          const key = ((payload.key || payload.entry.industry || payload.entry.term) || "").trim().toLowerCase();
          if (!key) return json({ error: { message: "Save needs a key (industry/term)." } }, 400, cors);
          map[key] = payload.entry;
        } else if (payload.action === "delete" && payload.key) {
          delete map[payload.key.trim().toLowerCase()];
        } else {
          return json({ error: { message: "Bad request — need action save/delete." } }, 400, cors);
        }
        await env.LIBRARY.put(kvKey, JSON.stringify(map));
        return json({ entries: sortEntries(map) }, 200, cors);
      }
      return json({ error: { message: "Method not allowed" } }, 405, cors);
    }

    // ── Anthropic proxy (default) ───────────────────────────────────────────────
    if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: { message: "Server has no ANTHROPIC_API_KEY secret. Add it under Settings → Variables and Secrets, then Deploy." } }, 500, cors);
    if (!accessOk) return json({ error: { message: "Wrong access password." } }, 401, cors);

    let body;
    try { body = await request.text(); } catch { return json({ error: { message: "Bad request body" } }, 400, cors); }

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body,
    });
    const headers = new Headers(cors);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

async function readMap(env, kvKey) {
  const raw = await env.LIBRARY.get(kvKey);
  return raw ? JSON.parse(raw) : {};
}
function sortEntries(map) {
  return Object.values(map).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
