// ─────────────────────────────────────────────────────────────────────────────
// Stock Explorer — Cloudflare Worker proxy + shared chain library
//
// Routes (all on the same Worker URL):
//   POST /          → proxy a request to Anthropic   (gated by ACCESS_PASSWORD)
//   GET  /library   → read the shared chain library   (gated by ACCESS_PASSWORD)
//   POST /library   → save/delete a chain             (gated by ACCESS_PASSWORD)
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
const KV_KEY = "chains"; // single JSON blob: { industryLower: {industry, chainData, result, sources, ts} }

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

    // ── Library routes ────────────────────────────────────────────────────────
    if (path === "/library") {
      if (!env.LIBRARY) return json({ error: { message: "Server has no LIBRARY KV binding. Create a KV namespace and bind it as LIBRARY, then Deploy." } }, 500, cors);

      if (request.method === "GET") {
        if (!accessOk) return json({ error: { message: "Wrong access password." } }, 401, cors);
        return json({ entries: await readEntries(env) }, 200, cors);
      }

      if (request.method === "POST") {
        if (!accessOk) return json({ error: { message: "Wrong access password." } }, 401, cors);
        let payload;
        try { payload = JSON.parse(await request.text()); } catch { return json({ error: { message: "Bad request body" } }, 400, cors); }

        const raw = await env.LIBRARY.get(KV_KEY);
        const map = raw ? JSON.parse(raw) : {};
        if (payload.action === "save" && payload.entry && payload.entry.industry) {
          map[payload.entry.industry.trim().toLowerCase()] = payload.entry;
        } else if (payload.action === "delete" && payload.key) {
          delete map[payload.key.trim().toLowerCase()];
        } else {
          return json({ error: { message: "Bad library request — need action save/delete." } }, 400, cors);
        }
        await env.LIBRARY.put(KV_KEY, JSON.stringify(map));
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

async function readEntries(env) {
  const raw = await env.LIBRARY.get(KV_KEY);
  return sortEntries(raw ? JSON.parse(raw) : {});
}
function sortEntries(map) {
  return Object.values(map).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
