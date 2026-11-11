const TARGET = "https://external.transitapp.com";
const GTFSRT = "https://api.octa.net/GTFSRealTime/protoBuf";

// STAGE-0: LLM prompts and JSON schemas live here — never client-supplied.
const PROMPTS = {
  parse:
    "You are the query preprocessor for a transit trip planner. " +
    "Split the user query into high_priority_anchors (specific named " +
    "places/brands that must anchor the route, normalized to canonical " +
    "name) and flexible_categories (generic venue categories, lowercase " +
    "OSM/Overture-style kinds like 'coffee shop'). Max 4 total stops. " +
    "If nothing parseable, return empty arrays.",
  assist:
    "You are the adventure planner for a transit trip planner. Turn the " +
    "request into an ordered multi-stop plan. Each stop: query (search " +
    "term), type ('anchor' for a specific named place, 'category' for a " +
    "generic venue kind), dwell_min (minutes on site), optional position " +
    "('first'|'middle'|'last'). Max 4 stops. Set round_trip when the rider " +
    "should end back at the start. Use depart_at/return_by (ISO times) " +
    "only when the request states them.",
};
const PARSE_SCHEMA = {
  type: "object",
  properties: {
    original_query: { type: "string" },
    high_priority_anchors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw_term: { type: "string" },
          normalized_entity_name: { type: "string" },
        },
        required: ["raw_term", "normalized_entity_name"],
        additionalProperties: false,
      },
    },
    flexible_categories: { type: "array", items: { type: "string" } },
  },
  required: ["original_query", "high_priority_anchors", "flexible_categories"],
  additionalProperties: false,
};
const ADVENTURE_SCHEMA = {
  type: "object",
  properties: {
    stops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string", enum: ["anchor", "category"] },
          dwell_min: { type: "number" },
          position: {
            type: ["string", "null"],
            enum: ["first", "middle", "last", null],
          },
        },
        required: ["query", "type", "dwell_min", "position"],
        additionalProperties: false,
      },
    },
    round_trip: { type: "boolean" },
    depart_at: { type: ["string", "null"] },
    return_by: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
  required: ["stops", "round_trip", "depart_at", "return_by", "notes"],
  additionalProperties: false,
};

// STAGE-0: Gemini takes an OpenAPI-3.0 subset — drop additionalProperties
// and fold type unions / null enum members.
function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      out.type = v.filter((t) => t !== "null")[0] || "string";
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.filter((e) => e !== null);
    } else out[k] = geminiSchema(v);
  }
  return out;
}

// STAGE-0: in-memory best-effort rate limits (per isolate).
const llmIps = new Map(),
  gmapsIps = new Map();
let llmDay = { key: "", count: 0 },
  gmapsMonth = { key: "", count: 0 };
function bucket(map, key, max, windowMs) {
  const now = Date.now(),
    b = map.get(key);
  if (!b || now > b.resetMs) {
    map.set(key, { count: 1, resetMs: now + windowMs });
    return 0;
  }
  b.count++;
  return b.count > max ? Math.ceil((b.resetMs - now) / 1000) : 0;
}

// STAGE-0
async function groq(env, prompt, user, name, schema) {
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name, strict: true, schema },
      },
      reasoning_effort: "low",
      include_reasoning: false,
      temperature: 1,
      top_p: 1,
      max_completion_tokens: 1024,
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

// STAGE-0: no temperature/top_p/top_k — deprecated for this model.
async function gemini(env, prompt, user, name, schema) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          response_mime_type: "application/json",
          response_json_schema: geminiSchema(schema),
          thinkingConfig: { thinking_level: "minimal" },
        },
      }),
    },
  );
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

// STAGE-0
async function llm(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const retry = bucket(llmIps, ip, 30, 60000);
  const today = new Date().toISOString().slice(0, 10);
  if (llmDay.key !== today) llmDay = { key: today, count: 0 };
  if (retry || llmDay.count >= 800)
    return Response.json(
      { error: "Rate limited" },
      {
        status: 429,
        headers: { ...cors, "Retry-After": String(retry || 3600) },
      },
    );
  llmDay.count++;
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* falls through to 400 */
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Response.json(
      { error: "JSON object body required" },
      { status: 400, headers: cors },
    );
  const { task, input, history, repair } = body;
  if (task !== "parse" && task !== "assist")
    return Response.json(
      { error: "task must be 'parse' or 'assist'" },
      { status: 400, headers: cors },
    );
  if (typeof input !== "string" || !input || input.length > 300)
    return Response.json(
      { error: "input must be a non-empty string of at most 300 chars" },
      { status: 400, headers: cors },
    );
  if (
    history !== undefined &&
    (!Array.isArray(history) ||
      history.length > 6 ||
      history.some(
        (h) =>
          !h || typeof h.role !== "string" || typeof h.content !== "string",
      ))
  )
    return Response.json(
      { error: "history must be an array of at most 6 {role,content} entries" },
      { status: 400, headers: cors },
    );
  let user = input;
  if (history?.length)
    user +=
      "\n\nContext:\n" +
      history.map((h) => `${h.role}: ${h.content}`).join("\n");
  if (repair && Array.isArray(repair.errors) && repair.errors.length)
    user += `\n\nPrevious attempt failed validation: ${repair.errors.join("; ")}. Return only valid JSON matching the schema.`;
  const schema = task === "parse" ? PARSE_SCHEMA : ADVENTURE_SCHEMA;
  const name = task === "parse" ? "semantic_parse" : "adventure_plan";
  const providers = (env.LLM_PROVIDERS || "groq,gemini")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const errors = [];
  for (const p of providers) {
    const call = p === "groq" ? groq : p === "gemini" ? gemini : null;
    if (!call) {
      errors.push(`${p}: unknown provider`);
      continue;
    }
    // STAGE-0: Gemini free tier throws intermittent 403/503 — one same-provider
    // retry before falling through to the next provider.
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return Response.json(
          await call(env, PROMPTS[task], user, name, schema),
          { headers: cors },
        );
      } catch (e) {
        last = e;
        if (!/ (403|429|5\d\d)$/.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    errors.push(`${p}: ${last.message}`);
  }
  return Response.json(
    { error: `All providers failed (${errors.join("; ")})` },
    { status: 502, headers: cors },
  );
}

// STAGE-0
async function gmaps(env, cors, url, ip) {
  if (!env.GMAPS_API_KEY)
    return Response.json(
      { error: "Relay not configured: GMAPS_API_KEY missing" },
      { status: 500, headers: cors },
    );
  const retry = bucket(gmapsIps, ip, 20, 60000);
  const month = new Date().toISOString().slice(0, 7);
  if (gmapsMonth.key !== month) gmapsMonth = { key: month, count: 0 };
  if (retry || gmapsMonth.count >= 850)
    return Response.json(
      { error: "Rate limited" },
      {
        status: 429,
        headers: { ...cors, "Retry-After": String(retry || 86400) },
      },
    );
  gmapsMonth.count++;
  const json = { "Content-Type": "application/json", ...cors };
  if (url.pathname === "/gmaps/text") {
    const query = url.searchParams.get("query");
    if (!query)
      return Response.json(
        { error: "query param required" },
        { status: 400, headers: cors },
      );
    const lat = Number(url.searchParams.get("lat")),
      lon = Number(url.searchParams.get("lon"));
    const body = { textQuery: query };
    if (Number.isFinite(lat) && Number.isFinite(lon))
      body.locationBias = {
        circle: { center: { latitude: lat, longitude: lon }, radius: 50000 },
      };
    const up = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GMAPS_API_KEY,
          "X-Goog-FieldMask": "places.id",
        },
        body: JSON.stringify(body),
      },
    );
    return new Response(up.body, { status: up.status, headers: json });
  }
  const id = url.searchParams.get("place_id");
  if (!id)
    return Response.json(
      { error: "place_id param required" },
      { status: 400, headers: cors },
    );
  const up = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?fields=rating,userRatingCount,priceLevel,currentOpeningHours.openNow`,
    { headers: { "X-Goog-Api-Key": env.GMAPS_API_KEY } },
  );
  return new Response(up.body, { status: up.status, headers: json });
}

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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const post = url.pathname === "/llm"; // STAGE-0: only /llm accepts POST
    if (request.method !== (post ? "POST" : "GET"))
      return Response.json(
        { error: post ? "POST requests only" : "GET requests only" },
        { status: 405, headers: cors },
      );
    if (post) return llm(request, env, cors);
    if (url.pathname === "/gmaps/text" || url.pathname === "/gmaps/details") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      return gmaps(env, cors, url, ip);
    }
    let upstream;
    if (url.pathname.startsWith("/gtfsrt/")) {
      // OCTA keyless GTFS-RT pass-through (CORS is absent upstream)
      upstream = await fetch(
        `${GTFSRT}${url.pathname.slice(7)}.aspx${url.search}`,
        {
          headers: {
            "Accept-Language": request.headers.get("Accept-Language") || "en",
          },
        },
      );
    } else {
      if (!env.TRANSIT_API_KEY)
        return Response.json(
          { error: "Relay not configured: TRANSIT_API_KEY missing" },
          { status: 500, headers: cors },
        );
      upstream = await fetch(TARGET + url.pathname + url.search, {
        headers: {
          apiKey: env.TRANSIT_API_KEY,
          "Accept-Language": request.headers.get("Accept-Language") || "en",
        },
      });
    }
    const headers = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
