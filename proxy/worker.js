// ─────────────────────────────────────────────────────────────────────────────
// Stock Explorer — Cloudflare Worker proxy + shared chain library
//
// Routes (all on the same Worker URL):
//   POST /          → proxy a request to Anthropic          (gated by ACCESS_PASSWORD)
//   GET/POST /library  → shared chain library (save/delete)  (gated by ACCESS_PASSWORD)
//   GET/POST /glossary → shared saved-glossary library       (gated by ACCESS_PASSWORD)
//   GET /market        → market data via Twelve Data         (gated by ACCESS_PASSWORD)
//   GET /edgar         → SEC EDGAR filings (tickers/submissions) (gated by ACCESS_PASSWORD)
//
// Your Anthropic and market-data keys are held server-side and never reach any browser.
//
// Set in the Cloudflare dashboard → your Worker → Settings:
//   Secrets (Variables and Secrets):
//     ANTHROPIC_API_KEY  — your Anthropic key (sk-ant-...)
//     ACCESS_PASSWORD    — shared password to use the app, open saved chains, and save chains
//     TWELVEDATA_KEY     — your free Twelve Data API key (for /market: charts + stats)
//     EDGAR_CONTACT      — your email; SEC requires it in the User-Agent (for /edgar)
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

    // ── Market data (Twelve Data proxy; key kept server-side) ───────────────────
    if (path === "/market") {
      if (!accessOk) return json({ error: { message: "Wrong access password." } }, 401, cors);
      if (!env.TWELVEDATA_KEY) return json({ error: { message: "Server has no TWELVEDATA_KEY secret. Add it under Settings -> Variables and Secrets, then Deploy." } }, 500, cors);
      const u = new URL(request.url);
      const EP = { quote:"quote", timeseries:"time_series", statistics:"statistics", profile:"profile" };
      const ep = EP[u.searchParams.get("fn")];
      const symbol = (u.searchParams.get("symbol") || "").trim();
      if (!ep || !symbol) return json({ error: { message: "Bad market request (need fn + symbol)." } }, 400, cors);
      const td = new URL("https://api.twelvedata.com/" + ep);
      td.searchParams.set("symbol", symbol);
      td.searchParams.set("apikey", env.TWELVEDATA_KEY);
      if (ep === "time_series") {
        td.searchParams.set("interval", u.searchParams.get("interval") || "1day");
        td.searchParams.set("outputsize", u.searchParams.get("outputsize") || "250");
      }
      let body = "{}", status = 502;
      try { const r = await fetch(td.toString()); body = await r.text(); status = r.status; }
      catch { return json({ error: { message: "Could not reach the market-data provider." } }, 502, cors); }
      const headers = new Headers(cors);
      headers.set("Content-Type", "application/json");
      return new Response(body, { status, headers });
    }

    // ── SEC EDGAR filings — streamed through with the SEC-required User-Agent ───
    // Pure passthrough (no JSON parsing) so large files stay well inside the Worker
    // CPU limit; responses are cached at Cloudflare's edge.
    if (path === "/edgar") {
      if (!accessOk) return json({ error: { message: "Wrong access password." } }, 401, cors);
      const contact = (env.EDGAR_CONTACT || "").trim();
      if (!contact) return json({ error: { message: "Server has no EDGAR_CONTACT variable. Add your email under Settings -> Variables and Secrets, then Deploy." } }, 500, cors);
      const u = new URL(request.url);
      const fn = u.searchParams.get("fn");
      let target, ttl;
      if (fn === "tickers") {
        target = "https://www.sec.gov/files/company_tickers.json"; ttl = 86400;
      } else if (fn === "submissions") {
        const cik = (u.searchParams.get("cik") || "").replace(/\D/g, "");
        if (!cik || cik.length > 10) return json({ error: { message: "Bad EDGAR request (need a numeric cik)." } }, 400, cors);
        target = "https://data.sec.gov/submissions/CIK" + cik.padStart(10, "0") + ".json"; ttl = 1800;
      } else {
        return json({ error: { message: "Bad EDGAR request (fn must be tickers or submissions)." } }, 400, cors);
      }
      let upstream;
      try {
        upstream = await fetch(target, {
          headers: { "User-Agent": "Market Explorer " + contact, "Accept": "application/json" },
          cf: { cacheTtl: ttl, cacheEverything: true },
        });
      } catch { return json({ error: { message: "Could not reach SEC EDGAR." } }, 502, cors); }
      if (upstream.status === 404) return json({ error: { message: "No SEC filings found for that company." } }, 404, cors);
      if (upstream.status === 403) return json({ error: { message: "SEC EDGAR refused the request (check EDGAR_CONTACT is a valid email)." } }, 502, cors);
      const headers = new Headers(cors);
      headers.set("Content-Type", "application/json");
      return new Response(upstream.body, { status: upstream.status, headers });
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
