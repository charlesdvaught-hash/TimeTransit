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
    "'board game bar', 'arcade bar', 'trivia bar'). If the query " +
    "expresses a rating or price intent ('highly rated', 'best', " +
    "'cheap', 'budget', 'upscale'), set min_rating (1-5; 'highly rated' " +
    "is ~4.3, 'best'/'top' ~4.5 — never 5 unless 'perfect' is said) " +
    "and/or " +
    "max_price (0-4: 0=free 1=cheap 2=moderate 3=expensive 4=luxury); " +
    "otherwise null. Max 4 total stops. If nothing parseable, return " +
    "empty arrays, related_terms: [], and null constraints.",
  rank:
    "You rank candidate places for a transit trip planner. Given a " +
    "JSON {query, candidates:[{name,kind}]}, return ranked_indices: the " +
    "candidate indices (0-based) that best match the query's intent — " +
    "including adjectives, vibes, cuisine, and price/rating hints — " +
    "best match first. Only include plausibly relevant indices; omit " +
    "clear mismatches. Judge only from the names and kinds given — " +
    "never invent places.",
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
    min_rating: { type: ["number", "null"] },
    max_price: { type: ["integer", "null"] },
  },
  required: [
    "original_query",
    "high_priority_anchors",
    "flexible_categories",
    "related_terms",
    "min_rating",
    "max_price",
  ],
  additionalProperties: false,
};
const RANK_SCHEMA = {
  type: "object",
  properties: {
    ranked_indices: { type: "array", items: { type: "integer" } },
  },
  required: ["ranked_indices"],
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
  if (task !== "parse" && task !== "assist" && task !== "rank")
    return Response.json(
      { error: "task must be 'parse', 'assist', or 'rank'" },
      { status: 400, headers: cors },
    );
  const inputCap = task === "rank" ? 4000 : 300;
  if (typeof input !== "string" || !input || input.length > inputCap)
    return Response.json(
      {
        error: `input must be a non-empty string of at most ${inputCap} chars`,
      },
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
  const schema =
    task === "parse"
      ? PARSE_SCHEMA
      : task === "rank"
        ? RANK_SCHEMA
        : assistSchema();
  const name =
    task === "parse"
      ? "semantic_parse"
      : task === "rank"
        ? "candidate_rank"
        : "adventure_plan";
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
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow",
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
// Eventbrite v3: public event search was shut down in Dec 2019, but
// /venues/{id}/events/ is public for any venue — so coverage is a curated
// list of OC venues. To add one: resolve any of the venue's events via
// GET /events/{event_id}/ -> venue_id, then GET /venues/{id}/ for coords.
const EB_VENUES = [
  // Santa Ana
  {
    id: "298598296",
    name: "Heritage Museum of OC",
    lat: 33.7207429,
    lon: -117.9106923,
  },
  // Newport Beach
  { id: "299948946", name: "Mutt Lynch's", lat: 33.6098222, lon: -117.9298659 },
  // Huntington Beach
  { id: "299921532", name: "The Circle OC", lat: 33.716183, lon: -117.9730931 },
  // Costa Mesa
  {
    id: "299878560",
    name: "Crowne Plaza Costa Mesa",
    lat: 33.6847379,
    lon: -117.8863201,
  },
  // Fullerton
  { id: "299890229", name: "Casa 723", lat: 33.8636346, lon: -117.9245569 },
];
// ~6h cache: N venue calls per /events request would burn quota; event
// lists change slowly so one refresh serves everyone.
let ebCache = { at: 0, rows: [] };
async function eventbrite(env, q, start, end) {
  if (!env.EVENTBRITE_API_KEY) return [];
  if (Date.now() - ebCache.at > 6 * 3600e3) {
    const rows = await Promise.all(
      EB_VENUES.map((v) =>
        fetch(
          `https://www.eventbriteapi.com/v3/venues/${v.id}/events/?status=live`,
          { headers: { Authorization: `Bearer ${env.EVENTBRITE_API_KEY}` } },
        )
          .then((r) => (r.ok ? r.json() : { events: [] }))
          .then((j) => (j.events || []).map((e) => ({ e, v })))
          .catch(() => []),
      ),
    );
    ebCache = { at: Date.now(), rows: rows.flat() };
  }
  const lo = q.toLowerCase();
  return ebCache.rows
    .filter(
      ({ e }) =>
        (e.start?.utc || "").slice(0, 19) >= start.slice(0, 19) &&
        (e.start?.utc || "").slice(0, 19) <= end.slice(0, 19) &&
        (!lo || (e.name?.text || "").toLowerCase().includes(lo)),
    )
    .map(({ e, v }) => ({
      id: `eb-${e.id}`,
      title: e.name?.text || "",
      venue: v.name,
      lat: v.lat,
      lon: v.lon,
      start: e.start?.utc,
      end: e.end?.utc !== e.start?.utc ? e.end?.utc : undefined,
      url: e.url,
      source: "eventbrite",
      note: e.is_free ? "free" : undefined,
    }));
}
// Resolve one public Eventbrite event + its venue into LocalEvent — used
// when assistant input contains an eventbrite.com/e/... link. Event lookup
// by id is one of the endpoints that survived the 2019 search shutdown.
async function ebEvent(env, cors, url, ip) {
  const retry = bucket(eventsIps, ip, 10, 60000);
  if (retry)
    return Response.json(
      { error: "Rate limited" },
      { status: 429, headers: { ...cors, "Retry-After": String(retry) } },
    );
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  if (!id || !env.EVENTBRITE_API_KEY)
    return Response.json(
      { error: "id param required" },
      { status: 400, headers: cors },
    );
  const h = { Authorization: `Bearer ${env.EVENTBRITE_API_KEY}` };
  const e = await fetch(`https://www.eventbriteapi.com/v3/events/${id}/`, {
    headers: h,
  }).then((r) => (r.ok ? r.json() : null));
  if (!e?.id)
    return Response.json(
      { error: "not found" },
      { status: 404, headers: cors },
    );
  const v = e.venue_id
    ? await fetch(`https://www.eventbriteapi.com/v3/venues/${e.venue_id}/`, {
        headers: h,
      }).then((r) => (r.ok ? r.json() : null))
    : null;
  return Response.json(
    {
      event: {
        id: `eb-${e.id}`,
        title: e.name?.text || "",
        venue: v?.name || "",
        lat: Number(v?.latitude || v?.address?.latitude),
        lon: Number(v?.longitude || v?.address?.longitude),
        start: e.start?.utc,
        end: e.end?.utc !== e.start?.utc ? e.end?.utc : undefined,
        url: e.url,
        source: "eventbrite",
        note: e.is_free ? "free" : undefined,
      },
    },
    { headers: cors },
  );
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
    ["eventbrite", eventbrite(env, q, start, end)],
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

// ---- Wave-3: feed resilience + OBA-shaped arrivals + watchdog ----

// Minimal GTFS-RT wire decoder — ported from src/gtfsrt.ts (same field
// numbers, same behavior). trip_id -> stop_id -> { d?: delay, t?: time }.
function pbFields(buf, start = 0, end = buf.length) {
  const out = [];
  let i = start;
  const varint = () => {
    let v = 0,
      s = 0n,
      b = 0;
    do {
      b = buf[i++];
      v = Number(BigInt(v) | (BigInt(b & 0x7f) << s));
      s += 7n;
    } while (b & 0x80 && i < end);
    return v;
  };
  while (i < end) {
    const tag = varint();
    const f = tag >> 3,
      wire = tag & 7;
    if (wire === 0) out.push({ f, wire, v: varint() });
    else if (wire === 1) {
      out.push({ f, wire, v: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = varint();
      out.push({ f, wire, v: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ f, wire, v: buf.subarray(i, i + 4) });
      i += 4;
    } else break;
  }
  return out;
}
const pbStr = (v) =>
  v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
const pbMsgs = (list, f) => list.filter((x) => x.f === f && x.wire === 2);
const pbNum = (list, f) =>
  list.find((x) => x.f === f && typeof x.v === "number")?.v;

// Decode trip updates into per-stop arrivals for ONE requested stop.
// TripDescriptor fields: 1 trip_id, 5 route_id, 6 direction_id.
// OCTA's static GTFS zero-pads stop_ids ("0002") while the RT feed emits
// them unpadded ("2") — compare the stripped form.
function arrivalsForStop(buf, stopId) {
  const want = stopId.replace(/^0+(?=\d)/, "");
  const out = [];
  for (const ent of pbMsgs(pbFields(buf), 2)) {
    for (const tu of pbMsgs(pbFields(ent.v), 3)) {
      const tuF = pbFields(tu.v);
      const tripMsg = pbMsgs(tuF, 1)[0];
      if (!tripMsg) continue;
      const tF = pbFields(tripMsg.v);
      const tripId = pbStr(tF.find((x) => x.f === 1)?.v);
      const routeId = pbStr(tF.find((x) => x.f === 5)?.v);
      for (const stu of pbMsgs(tuF, 2)) {
        const sF = pbFields(stu.v);
        const got = pbStr(sF.find((x) => x.f === 4)?.v);
        if (got !== stopId && got !== want) continue;
        const arr = { tripId, routeId };
        for (const ev of [pbMsgs(sF, 2)[0], pbMsgs(sF, 3)[0]]) {
          if (!ev) continue;
          const eF = pbFields(ev.v);
          const d = pbNum(eF, 1),
            t = pbNum(eF, 2);
          if (d !== undefined) arr.delaySec = d;
          if (t !== undefined) arr.predictedTime = t * 1000;
        }
        if (arr.predictedTime !== undefined || arr.delaySec !== undefined)
          out.push(arr);
      }
    }
  }
  return out;
}

// Cache-API read-through for the OCTA feeds: fresh <30s serves from cache,
// upstream failures serve the last good copy instead of erroring. This is
// the resilience layer — an api.octa.net 522 becomes invisible.
const FEED_TTL_MS = 30_000;
async function cachedFeed(name) {
  const cache = caches.default;
  const key = new Request(`https://feed-cache.internal/${name}`);
  const hit = await cache.match(key);
  const hitAge = hit
    ? Date.now() - Number(hit.headers.get("x-stored-at") || 0)
    : 0;
  if (hit && hitAge < FEED_TTL_MS)
    return { body: await hit.arrayBuffer(), stale: false, age: hitAge };
  try {
    const up = await fetch(`${GTFSRT}/${name}.aspx`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!up.ok) throw new Error(`upstream ${up.status}`);
    const body = await up.arrayBuffer();
    const stored = new Response(body, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "public, max-age=3600",
        "x-stored-at": String(Date.now()),
      },
    });
    await cache.put(key, stored);
    return { body, stale: false, age: 0 };
  } catch (e) {
    if (hit)
      return { body: await hit.arrayBuffer(), stale: true, age: hitAge };
    throw e;
  }
}

// /api/arrivals?stop=<stop_id> — OBA-slim shape: the same answers OBA's
// arrivals-and-departures-for-stop gives, decoded server-side so the
// client (and future providers) get JSON instead of protobuf.
async function arrivals(cors, url, ip) {
  const retry = bucket(nearbyIps, ip, 30, 60000);
  if (retry) return limited(retry, cors);
  const stopId = (url.searchParams.get("stop") || "").trim();
  if (!stopId)
    return Response.json(
      { error: "stop param required" },
      { status: 400, headers: cors },
    );
  let feed;
  try {
    feed = await cachedFeed("tripupdates");
  } catch (e) {
    return Response.json(
      { error: `upstream request failed (${e.message})` },
      { status: 502, headers: cors },
    );
  }
  const list = arrivalsForStop(new Uint8Array(feed.body), stopId)
    .filter(
      (a) =>
        a.predictedTime === undefined ||
        a.predictedTime > Date.now() - 300_000,
    )
    .sort((a, b) => (a.predictedTime || Infinity) - (b.predictedTime || Infinity))
    .slice(0, 8);
  return Response.json(
    {
      stopId,
      generatedAt: Date.now(),
      stale: feed.stale,
      feedAgeMs: feed.age,
      source: "octa-gtfsrt",
      arrivals: list.map((a) => ({ ...a, realtime: true })),
    },
    { headers: cors },
  );
}

// /api/health — last watchdog probe result, plus freshness. The cron fills
// this; if KV is empty the worker is still alive but the probe hasn't run.
async function health(env, cors) {
  const stored = env.TT_STATE_KV
    ? await env.TT_STATE_KV.get("health:latest", "json").catch(() => null)
    : null;
  return Response.json(
    { ok: true, worker: "up", now: Date.now(), probe: stored },
    { headers: cors },
  );
}

// Cron probe — every 5 min, checks each upstream the app depends on and
// records a compact verdict in KV. ~288 writes/day, under the free cap.
async function runProbe(env) {
  const check = async (name, url, opts = {}) => {
    const t = Date.now();
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        ...opts,
      });
      const body = await r.arrayBuffer();
      return { ok: r.ok, status: r.status, ms: Date.now() - t, bytes: body.byteLength };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, error: String(e).slice(0, 80) };
    }
  };
  const probe = {
    ts: Date.now(),
    octa_tripupdates: await check("tu", `${GTFSRT}/tripupdates.aspx`),
    octa_vehicles: await check("vp", `${GTFSRT}/VehiclePositions.aspx`),
    transitous: await check(
      "motis",
      `${MOTIS}/api/v1/map/stops?min=33.7,-117.9&max=33.71,-117.89`,
      { headers: MOTIS_HEADERS },
    ),
    photon: await check("photon", "https://photon.komoot.io/api/?q=test&limit=1"),
  };
  if (env.TT_STATE_KV)
    await env.TT_STATE_KV.put("health:latest", JSON.stringify(probe));
  return probe;
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
    if (url.pathname === "/api/arrivals") {
      if (request.method !== "GET")
        return Response.json(
          { error: "GET requests only" },
          { status: 405, headers: cors },
        );
      return arrivals(cors, url, ip);
    }
    if (url.pathname === "/api/health") {
      if (request.method !== "GET")
        return Response.json(
          { error: "GET requests only" },
          { status: 405, headers: cors },
        );
      return health(env, cors);
    }
    // Manual probe trigger for debugging — same code the cron runs.
    if (url.pathname === "/api/probe") {
      if (request.method !== "GET")
        return Response.json(
          { error: "GET requests only" },
          { status: 405, headers: cors },
        );
      return Response.json(await runProbe(env), { headers: cors });
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
    if (url.pathname === "/eb/event") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      return ebEvent(env, cors, url, ip);
    }
    let upstream;
    if (url.pathname.startsWith("/gtfsrt/")) {
      // OCTA keyless GTFS-RT pass-through — now cache-backed: fresh <30s
      // comes from the edge cache, upstream failures serve last-good.
      const name = url.pathname.slice(8);
      try {
        const feed = await cachedFeed(name);
        return new Response(feed.body, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-feed-stale": feed.stale ? "1" : "0",
            "x-feed-age-ms": String(Math.round(feed.age)),
            ...cors,
          },
        });
      } catch (e) {
        return Response.json(
          { error: `upstream request failed (${e.message})` },
          { status: 502, headers: cors },
        );
      }
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

  // Cron trigger — configured via the Workers schedules API. Probes every
  // upstream and records the verdict in KV for /api/health + the scoreboard.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runProbe(env));
  },
};
