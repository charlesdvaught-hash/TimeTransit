const TARGET = "https://external.transitapp.com";
const GTFSRT = "https://api.octa.net/GTFSRealTime/protoBuf";
// W1: Transitous/MOTIS for keyless server-side planning + nearby departures.
const MOTIS = "https://api.transitous.org";
// transitous 403s UA-less requests; matches src/api.ts' server-side UA.
const MOTIS_HEADERS = {
  "User-Agent": "TimeTransit/1.0 (local transit explorer)",
};
// W1: single-blob KV state sync (mirrors the client-side localStorage shape).
const STATE_KEY = "state:v1";
const EMPTY_STATE = {
  bookmarks: [],
  favoriteLines: [],
  recentSearches: [],
  updatedAt: 0,
};

// STAGE-0: LLM prompts and JSON schemas live here — never client-supplied.
const PROMPTS = {
  parse:
    "You are the query preprocessor for a transit trip planner. " +
    "Split the user query into high_priority_anchors (specific named " +
    "places/brands that must anchor the route, normalized to canonical " +
    "name) and flexible_categories (generic venue types, preserving " +
    "descriptive adjectives and vibes like 'nerdy bar' or 'quiet coffee " +
    "shop' rather than stripping them to bare nouns). When a query has " +
    "descriptive modifiers, vibes, cuisine, price, or rating hints that " +
    "name indexes may not know ('nerdy', 'budget', 'cozy', 'highly " +
    "rated'), also return related_terms: 2-4 concrete searchable " +
    "venue-type expansions preserving the intent (e.g. 'nerdy bar' -> " +
    "'board game bar', 'arcade bar', 'trivia bar'). Max 4 total stops. " +
    "If nothing parseable, return empty arrays and related_terms: [].",
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
    "When a requested time can't be expressed as a date the schema " +
    "allows, set the field to null — never emit an error object. " +
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
    related_terms: { type: "array", items: { type: "string" } },
  },
  required: [
    "original_query",
    "high_priority_anchors",
    "flexible_categories",
    "related_terms",
  ],
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

// Constrained decoding honors string `pattern`, so the assist schema
// clamps depart_at/return_by to a rolling window: yesterday (absorbs
// client-vs-worker timezone skew) through ~62 days out. Stale or
// far-future dates can't be emitted at the token level.
function dateWindowPattern(now = new Date()) {
  const days = [];
  for (let i = -1; i <= 62; i++)
    days.push(
      new Date(now.getTime() + i * 86400000).toISOString().slice(0, 10),
    );
  // a bare "T" satisfies ^(dates)T — require HH:MM so the model can't
  // truncate the timestamp to dodge the constraint
  return `^(${days.join("|")})T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$`;
}
function assistSchema() {
  const p = dateWindowPattern();
  return {
    ...ADVENTURE_SCHEMA,
    properties: {
      ...ADVENTURE_SCHEMA.properties,
      depart_at: { type: ["string", "null"], pattern: p },
      return_by: { type: ["string", "null"], pattern: p },
    },
  };
}

// STAGE-0: Gemini takes an OpenAPI-3.0 subset — drop additionalProperties
// and fold type unions / null enum members. `pattern` survives: it's
// guidance-level for Gemini (Groq enforces it at the token level), but
// the model demonstrably respects the date window.
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
  gmapsIps = new Map(),
  stateIps = new Map(),
  boardIps = new Map(),
  nearbyIps = new Map(),
  planIps = new Map();
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
  const schema = task === "parse" ? PARSE_SCHEMA : assistSchema();
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

// ---- W1: KV state sync + MOTIS proxies ----

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && !!v;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const bearer = (request) => {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};
const limited = (retry, cors) =>
  Response.json(
    { error: "Rate limited" },
    { status: 429, headers: { ...cors, "Retry-After": String(retry) } },
  );

// Mirrors contracts.ts: SavedPlace / FavoriteLine / RecentSearch.
const validBookmark = (b) =>
  isObj(b) &&
  isStr(b.id) &&
  isStr(b.label) &&
  ["home", "work", "gym", "pin"].includes(b.icon) &&
  isNum(b.lat) &&
  isNum(b.lon) &&
  isNum(b.updatedAt);
const validFavorite = (f) => isObj(f) && isStr(f.routeId) && isStr(f.shortName);
const validRecent = (r) =>
  isObj(r) && isStr(r.id) && isStr(r.label) && isNum(r.ts);

// GET/PUT a single JSON blob at state:v1. Bearer TT_SYNC_TOKEN required.
async function state(request, env, cors, ip) {
  if (!env.TT_SYNC_TOKEN || !env.TT_STATE_KV)
    return Response.json(
      { error: "sync not configured" },
      { status: 503, headers: cors },
    );
  if (bearer(request) !== env.TT_SYNC_TOKEN)
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: cors },
    );
  const retry = bucket(stateIps, ip, 30, 60000);
  if (retry) return limited(retry, cors);
  if (request.method === "GET") {
    const stored = await env.TT_STATE_KV.get(STATE_KEY, "json");
    return Response.json(isObj(stored) ? stored : EMPTY_STATE, {
      headers: cors,
    });
  }
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* falls through to 400 */
  }
  if (!isObj(body))
    return Response.json(
      { error: "JSON object body required" },
      { status: 400, headers: cors },
    );
  const { bookmarks, favoriteLines, recentSearches, updatedAt } = body;
  if (
    !Array.isArray(bookmarks) ||
    bookmarks.length > 4 ||
    bookmarks.some((b) => !validBookmark(b))
  )
    return Response.json(
      {
        error:
          "bookmarks must be an array of at most 4 {id,label,icon,lat,lon,updatedAt}",
      },
      { status: 400, headers: cors },
    );
  if (
    !Array.isArray(favoriteLines) ||
    favoriteLines.length > 32 ||
    favoriteLines.some((f) => !validFavorite(f))
  )
    return Response.json(
      {
        error:
          "favoriteLines must be an array of at most 32 {routeId,shortName}",
      },
      { status: 400, headers: cors },
    );
  if (
    !Array.isArray(recentSearches) ||
    recentSearches.length > 8 ||
    recentSearches.some((r) => !validRecent(r))
  )
    return Response.json(
      { error: "recentSearches must be an array of at most 8 {id,label,ts}" },
      { status: 400, headers: cors },
    );
  if (!isNum(updatedAt) || updatedAt < 0)
    return Response.json(
      { error: "updatedAt must be a non-negative number" },
      { status: 400, headers: cors },
    );
  const blob = { bookmarks, favoriteLines, recentSearches, updatedAt };
  await env.TT_STATE_KV.put(STATE_KEY, JSON.stringify(blob));
  return Response.json(blob, { headers: cors });
}

// Earliest-arriving transit option from the origin to each bookmark.
// Mirrors the client's MOTIS plan params (fromPlace/toPlace/time/arriveBy).
async function board(cors, request, ip) {
  const retry = bucket(boardIps, ip, 20, 60000);
  if (retry) return limited(retry, cors);
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* falls through to 400 */
  }
  if (
    !isObj(body) ||
    !isObj(body.origin) ||
    !isNum(body.origin.lat) ||
    !isNum(body.origin.lon)
  )
    return Response.json(
      { error: "origin {lat,lon} required" },
      { status: 400, headers: cors },
    );
  const marks = body.bookmarks;
  if (
    !Array.isArray(marks) ||
    marks.length > 4 ||
    marks.some(
      (m) => !isObj(m) || !isStr(m.id) || !isNum(m.lat) || !isNum(m.lon),
    )
  )
    return Response.json(
      { error: "bookmarks must be an array of at most 4 {id,label,lat,lon}" },
      { status: 400, headers: cors },
    );
  const now = new Date().toISOString();
  const results = await Promise.allSettled(
    marks.map(async (m) => {
      const p = new URLSearchParams({
        fromPlace: `${body.origin.lat},${body.origin.lon}`,
        toPlace: `${m.lat},${m.lon}`,
        time: now,
        arriveBy: "false",
        numItineraries: "3",
      });
      const r = await fetch(`${MOTIS}/api/v1/plan?${p}`, {
        headers: MOTIS_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`motis ${r.status}`);
      const data = await r.json();
      const best = [...(data.itineraries || []), ...(data.direct || [])]
        .filter((i) => isStr(i.startTime) && isStr(i.endTime))
        .sort((a, b) => (a.endTime < b.endTime ? -1 : 1))[0];
      if (!best) return null;
      const summary = (best.legs || [])
        .map((l) => l.routeShortName || l.headsign || l.mode)
        .filter(Boolean)
        .join(" → ");
      return {
        id: m.id,
        label: typeof m.label === "string" ? m.label : "",
        departISO: best.startTime,
        arriveISO: best.endTime,
        durationMin: isNum(best.duration)
          ? Math.round(best.duration / 60)
          : Math.round(
              (Date.parse(best.endTime) - Date.parse(best.startTime)) / 60000,
            ),
        summary,
      };
    }),
  );
  return Response.json(
    {
      board: results.map((r) => (r.status === "fulfilled" ? r.value : null)),
      sources: ["motis"],
    },
    { headers: cors },
  );
}

// Nearest MOTIS stops in a radius + up to 3 departures each.
async function nearbyStops(cors, url, ip) {
  const retry = bucket(nearbyIps, ip, 20, 60000);
  if (retry) return limited(retry, cors);
  const rawLat = url.searchParams.get("lat"),
    rawLon = url.searchParams.get("lon"),
    lat = Number(rawLat),
    lon = Number(rawLon);
  if (
    rawLat === null ||
    rawLon === null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  )
    return Response.json(
      { error: "lat and lon params required" },
      { status: 400, headers: cors },
    );
  let radius = Number(url.searchParams.get("radius"));
  if (!Number.isFinite(radius) || radius <= 0) radius = 450;
  radius = Math.min(radius, 2000);
  const dlat = radius / 111320,
    dlon = radius / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  const p = new URLSearchParams({
    min: `${lat - dlat},${lon - dlon}`,
    max: `${lat + dlat},${lon + dlon}`,
  });
  let stops;
  try {
    const r = await fetch(`${MOTIS}/api/v1/map/stops?${p}`, {
      headers: MOTIS_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`motis ${r.status}`);
    stops = await r.json();
  } catch (e) {
    return Response.json(
      { error: `upstream request failed (${e.message})` },
      { status: 502, headers: cors },
    );
  }
  const dist2 = (s) => {
    const dy = (s.lat - lat) * 111320,
      dx = (s.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
    return dx * dx + dy * dy;
  };
  const top = (Array.isArray(stops) ? stops : [])
    .filter((s) => isObj(s) && s.stopId && isNum(s.lat) && isNum(s.lon))
    .sort((a, b) => dist2(a) - dist2(b))
    .slice(0, 6);
  const now = new Date().toISOString();
  const deps = await Promise.allSettled(
    top.map(async (s) => {
      const q = new URLSearchParams({
        stopId: s.stopId,
        time: now,
        n: "4",
        arriveBy: "false",
      });
      const r = await fetch(`${MOTIS}/api/v1/stoptimes?${q}`, {
        headers: MOTIS_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.stopTimes || [])
        .filter((t) => isStr(t?.place?.departure))
        .sort((a, b) => (a.place.departure < b.place.departure ? -1 : 1))
        .slice(0, 3)
        .map((t) => ({
          routeName: t.routeShortName || t.displayName || t.agencyName || "",
          headsign: typeof t.headsign === "string" ? t.headsign : "",
          departISO: t.place.departure,
          realtime: !!t.realTime,
        }));
    }),
  );
  return Response.json(
    {
      stops: top.map((s, i) => ({
        id: s.stopId,
        name: s.name || "",
        lat: s.lat,
        lon: s.lon,
        departures: deps[i].status === "fulfilled" ? deps[i].value : [],
      })),
    },
    { headers: cors },
  );
}

// JSON-body plan proxy for arrive-by queries. MOTIS on transitous is
// GET-only (POST /api/v*/plan → 404 upstream), so the JSON body's scalar
// fields are translated into query params — arriveBy, numItineraries, walk
// prefs, etc. all pass through 1:1.
async function planProxy(cors, request, ip) {
  const retry = bucket(planIps, ip, 30, 60000);
  if (retry) return limited(retry, cors);
  let body = null;
  try {
    body = await request.json();
  } catch {
    /* falls through to 400 */
  }
  if (!isObj(body))
    return Response.json(
      { error: "JSON object body required" },
      { status: 400, headers: cors },
    );
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    )
      p.set(k, String(v));
    else
      return Response.json(
        { error: `field '${k}' must be a scalar` },
        { status: 400, headers: cors },
      );
  }
  let up;
  try {
    up = await fetch(`${MOTIS}/api/v1/plan?${p}`, {
      headers: MOTIS_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return Response.json(
      { error: `upstream request failed (${e.message})` },
      { status: 502, headers: cors },
    );
  }
  return new Response(up.body, {
    status: up.status,
    headers: { "Content-Type": "application/json", ...cors },
  });
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    // W1: state sync accepts GET+PUT; the rest of /api/* is POST or GET.
    if (url.pathname === "/api/state") {
      if (request.method !== "GET" && request.method !== "PUT")
        return Response.json(
          { error: "GET or PUT requests only" },
          { status: 405, headers: cors },
        );
      return state(request, env, cors, ip);
    }
    if (url.pathname === "/api/board" || url.pathname === "/api/plan") {
      if (request.method !== "POST")
        return Response.json(
          { error: "POST requests only" },
          { status: 405, headers: cors },
        );
      return url.pathname === "/api/board"
        ? board(cors, request, ip)
        : planProxy(cors, request, ip);
    }
    if (url.pathname === "/api/nearby") {
      if (request.method !== "GET")
        return Response.json(
          { error: "GET requests only" },
          { status: 405, headers: cors },
        );
      return nearbyStops(cors, url, ip);
    }
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
