const TARGET = "https://external.transitapp.com";
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((o) => o.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin)
        ? origin
        : allowed[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET")
      return Response.json(
        { error: "GET requests only" },
        { status: 405, headers: cors },
      );
    if (!env.TRANSIT_API_KEY)
      return Response.json(
        { error: "Relay not configured: TRANSIT_API_KEY missing" },
        { status: 500, headers: cors },
      );
    const url = new URL(request.url);
    const upstream = await fetch(TARGET + url.pathname + url.search, {
      headers: {
        apiKey: env.TRANSIT_API_KEY,
        "Accept-Language": request.headers.get("Accept-Language") || "en",
      },
    });
    const headers = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
