// Static site host with a shared-secret gate. First visit carries ?key=...;
// a 30-day cookie keeps the URL clean afterwards. Anything else gets a 404 —
// the site is indistinguishable from nonexistent to casual discovery.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const cookie = request.headers.get("Cookie") || "";
    if (key !== env.SITE_KEY && !cookie.includes(`tt_gate=${env.SITE_KEY}`))
      return new Response("Not found", { status: 404 });
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
