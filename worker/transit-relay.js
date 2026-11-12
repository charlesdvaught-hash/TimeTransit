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
    "generic venue kind, 'event' for a happening like a concert, game, " +
    "festival, or show the user wants to attend — put the act or event " +
    "name in query), dwell_min (minutes on site), optional position " +
    "('first'|'middle'|'last'). Max 4 stops. Set round_trip when the rider " +
    "should end back at the start. Use depart_at/return_by (ISO times) " +
    "only when the request states them; resolve relative times like " +
    "'back by 6' against the 'Current local time' line when present — " +
    "a named weekday means the next future date having that weekday. " +
    "Stops are places only; never emit transit legs or 'home' as stops.",
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
          type: { type: "string", enum: ["anchor", "category", "event"] },
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

const eventsIps = new Map();
const eventsDay = { key: "", count: 0 };
const stripHtml = (s) =>
  typeof s === "string"
    ? s
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .trim()
    : "";

// Fan-out to event providers; each maps rows into the LocalEvent shape the
// client shares with contracts.ts. Failures return [] so one dead source
// can't sink the rest.
async function seatgeek(env, lat, lon, q, start, end) {
  if (!env.SEATGEEK_CLIENT_ID) return [];
  const u =
    `https://api.seatgeek.com/2/events?lat=${lat}&lon=${lon}&range=10mi` +
    `&datetime_local.gte=${encodeURIComponent(start)}` +
    `&datetime_local.lte=${encodeURIComponent(end)}` +
    (q ? `&q=${encodeURIComponent(q)}` : "") +
    `&per_page=15&client_id=${env.SEATGEEK_CLIENT_ID}`;
  const j = await (await fetch(u)).json();
  return (j.events || [])
    .map((e) => ({
      id: `sg-${e.id}`,
      title: e.title,
      venue: e.venue?.name || "",
      lat: e.venue?.location?.lat,
      lon: e.venue?.location?.lon,
      start: e.datetime_local,
      url: e.url,
      source: "seatgeek",
      note: e.stats?.lowest_price ? `from $${e.stats.lowest_price}` : undefined,
    }))
    .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
}
async function lacity(q, start, end) {
  let where = `start between '${start}' and '${end}' and lat is not null`;
  if (q)
    where += ` and upper(title) like '%${q.replace(/'/g, "").toUpperCase()}%'`;
  const u =
    "https://data.lacity.org/resource/9aw9-mn4p.json?$where=" +
    encodeURIComponent(where) +
    "&$select=title,start,end,lat,long,url,eventcost,eventtype,street,city&$limit=15";
  const rows = await (await fetch(u)).json();
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: `la-${r.start}-${r.title?.slice(0, 24)}`,
    title: stripHtml(r.title),
    venue: stripHtml(r.street) || stripHtml(r.city) || "",
    lat: Number(r.lat),
    lon: Number(r.long),
    start: r.start,
    end: r.end || undefined,
    url: r.url?.url,
    source: "lacity",
    note: stripHtml(r.eventcost) || stripHtml(r.eventtype) || undefined,
  }));
}
async function santamonica(q, start, end) {
  let sql =
    `SELECT * FROM "a8ecb913-330d-4be9-a0cd-9ebbde8650de"` +
    ` WHERE start_date >= '${start.slice(0, 10)}' AND start_date <= '${end.slice(0, 10)}'` +
    (q ? ` AND title ILIKE '%${q.replace(/'/g, "")}%'` : "") +
    " LIMIT 15";
  const u =
    "https://data.santamonica.gov/api/3/action/datastore_search_sql?sql=" +
    encodeURIComponent(sql);
  const j = await (await fetch(u)).json();
  return (j.result?.records || [])
    .map((r) => {
      const m = /\((-?\d+\.\d+),\s*(-?\d+\.\d+)\)/.exec(r.address || "");
      if (!m) return null;
      return {
        id: `sm-${r.id}`,
        title: r.title,
        venue: r.location || "",
        lat: Number(m[1]),
        lon: Number(m[2]),
        start: r.start_date,
        end: r.end_date !== r.start_date ? r.end_date : undefined,
        url: r.detail_url || r.signup_url || undefined,
        source: "santamonica",
        note: r.event_types || undefined,
      };
    })
    .filter(Boolean);
}
async function mobilizon(lat, lon, q, start, end) {
  const gql = {
    query: `{searchEvents(location:"${lon},${lat}",radius:40,${q ? `term:"${q}",` : ""}beginsOn:"${start}",endsOn:"${end}",limit:10){elements{id title beginsOn endsOn url physicalAddress{geom description locality}}}}`,
  };
  const r = await fetch("https://mobilizon.fr/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(gql),
  });
  const els = (await r.json()).data?.searchEvents?.elements || [];
  return els
    .map((e) => {
      const g = (e.physicalAddress?.geom || "").split(/[,;]/).map(Number);
      return {
        id: `mz-${e.id}`,
        title: e.title,
        venue:
          e.physicalAddress?.description || e.physicalAddress?.locality || "",
        lat: g[1],
        lon: g[0],
        start: e.beginsOn,
        end: e.endsOn || undefined,
        url: e.url,
        source: "mobilizon",
      };
    })
    .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
}
async function events(env, cors, url, ip) {
  const retry = bucket(eventsIps, ip, 10, 60000);
  const day = new Date().toISOString().slice(0, 10);
  if (eventsDay.key !== day) {
    eventsDay.key = day;
    eventsDay.count = 0;
  }
  if (retry || eventsDay.count >= 400)
    return Response.json(
      { error: "Rate limited" },
      {
        status: 429,
        headers: { ...cors, "Retry-After": String(retry || 86400) },
      },
    );
  eventsDay.count++;
  const lat = Number(url.searchParams.get("lat")),
    lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return Response.json(
      { error: "lat and lon params required" },
      { status: 400, headers: cors },
    );
  const q = (url.searchParams.get("q") || "").slice(0, 80),
    now = Date.now(),
    start =
      url.searchParams.get("start") || new Date(now).toISOString().slice(0, 19),
    end =
      url.searchParams.get("end") ||
      new Date(now + 14 * 864e5).toISOString().slice(0, 19);
  const jobs = [
    ["seatgeek", seatgeek(env, lat, lon, q, start, end)],
    ["lacity", lacity(q, start, end)],
    ["santamonica", santamonica(q, start, end)],
    ["mobilizon", mobilizon(lat, lon, q, start, end)],
  ];
  const settled = await Promise.allSettled(jobs.map(([, j]) => j));
  const sources = jobs.map(([n], i) =>
    settled[i].status === "fulfilled" ? n : `${n}:down`,
  );
  const list = settled
    .flatMap((s) => (s.status === "fulfilled" ? s.value : []))
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .slice(0, 40);
  return Response.json({ events: list, sources }, { headers: cors });
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
    if (url.pathname === "/events") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      return events(env, cors, url, ip);
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
