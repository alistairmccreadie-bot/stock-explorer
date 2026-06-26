// ─────────────────────────────────────────────────────────────────────────────
// Stock Explorer — Cloudflare Worker proxy
//
// Holds your Anthropic API key as a server-side SECRET so it never reaches any
// user's browser. The web app calls THIS worker (with a shared password); the
// worker checks the password, attaches the real key, and forwards to Anthropic.
// Streaming (SSE) passes straight through.
//
// Set these in the Cloudflare dashboard → your Worker → Settings → Variables:
//   Secrets:
//     ANTHROPIC_API_KEY  — your Anthropic key (sk-ant-...)
//     ACCESS_PASSWORD    — the shared password you hand to your group
//   (optional) Plaintext variable:
//     ALLOWED_ORIGIN     — your site origin; defaults to the GitHub Pages site below
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ORIGIN = "https://alistairmccreadie-bot.github.io";

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-access-code",
      "Access-Control-Max-Age": "86400",
    };

    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST")   return json({ error: { message: "Method not allowed" } }, 405, cors);

    // Shared-password gate
    const code = request.headers.get("x-access-code") || "";
    if (!env.ACCESS_PASSWORD || code !== env.ACCESS_PASSWORD) {
      return json({ error: { message: "Wrong or missing access password." } }, 401, cors);
    }

    let body;
    try { body = await request.text(); } catch { return json({ error: { message: "Bad request body" } }, 400, cors); }

    // Forward to Anthropic with the real key attached on the server.
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    // Pass the response (JSON or SSE stream) straight back to the browser.
    const headers = new Headers(cors);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
