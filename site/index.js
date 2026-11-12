// Static site host with a shared-secret gate. First visit carries ?key=...;
// a 30-day cookie keeps the URL clean afterwards. Anything else gets a 404 —
// the site is indistinguishable from nonexistent to casual discovery.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Cloudflare Access asserts the verified email on every request; until
    // Access is enabled the ?key gate still runs and sync uses a shared blob.
    const authed = request.headers.get("Cf-Access-Authenticated-Email");
    const key = url.searchParams.get("key");
    const cookie = request.headers.get("Cookie") || "";
    if (
      !authed &&
      key !== env.SITE_KEY &&
      !cookie.includes(`tt_gate=${env.SITE_KEY}`)
    )
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/api/state") return stateApi(request, env, authed);
    const res = await env.ASSETS.fetch(request);
    if (!key) return res;
    const headers = new Headers(res.headers);
    headers.append(
      "Set-Cookie",
      `tt_gate=${env.SITE_KEY}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    );
    return new Response(res.body, { status: res.status, headers });
  },
};

const EMPTY = { bookmarks: [], favoriteLines: [], recentSearches: [], updatedAt: 0 };

// Per-user sync blob, keyed by verified email (or "shared" pre-Access).
async function stateApi(request, env, email) {
  const k = `state:${(email || "shared").toLowerCase()}`;
  if (request.method === "GET") {
    const stored = await env.TT_STATE_KV.get(k, "json");
    return Response.json(stored && typeof stored === "object" ? stored : EMPTY);
  }
  if (request.method !== "PUT")
    return Response.json({ error: "GET or PUT only" }, { status: 405 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object")
    return Response.json({ error: "JSON object body required" }, { status: 400 });
  await env.TT_STATE_KV.put(k, JSON.stringify(body));
  return Response.json(body);
}
