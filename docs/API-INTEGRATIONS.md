# API Integrations

Every external service the app talks to, what it's for, what credentials it
needs, what it costs, and how the app behaves when it's down. Sources:
`AGENTS.md` verified facts, the old README provider notes, and the code — all
figures below are verified receipts, not guesses.

Client env vars live in `.env.local` (gitignored). Worker secrets are set via
`npx wrangler secret put` (or `worker/.dev.vars` locally). See
[DEPLOYMENT.md](DEPLOYMENT.md) for relay/site configuration.

## Overview

| Provider                                   | Used for                                         | Credentials                                                     | Where the call happens                                             |
| ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Transitous / MOTIS                         | Journey plans, reachable-stop queries, map stops | None                                                            | Browser direct                                                     |
| Photon (komoot)                            | Geocoding + category place search                | None                                                            | Browser direct                                                     |
| OCTA GTFS (static)                         | Local reachability scan index                    | None                                                            | Build-time preprocess → `public/scan/octa.json`                    |
| OCTA GTFS-Realtime                         | Trip delays + service alerts                     | None (keyless, no CORS)                                         | `/gtfsrt/*` dev proxy or relay                                     |
| LA Metro API v2 (`api.metro.net`)          | Live bus/rail vehicle positions                  | None (keyless, beta)                                            | Browser WebSocket direct — no CORS needed                          |
| Transit API v4                             | Live departure ETAs                              | `VITE_TRANSIT_API_KEY` (dev) / `TRANSIT_API_KEY` secret (relay) | `/transit` dev proxy or `/v4/*` relay — **never direct** (no CORS) |
| TomTom Search                              | Business/address suggestion fallback             | `VITE_TOMTOM_API_KEY` (client-visible)                          | Browser direct                                                     |
| Overture Maps                              | Local business index                             | None                                                            | Build-time preprocess → `public/places/oc.json`                    |
| Groq / Gemini                              | LLM `parse`/`rank`/`assist` tasks                | `GROQ_API_KEY`, `GEMINI_API_KEY` secrets                        | Relay `POST /llm` only                                             |
| Google Places                              | Ratings/hours/price enrichment                   | `GMAPS_API_KEY` secret                                          | Relay `/gmaps/*`                                                   |
| Google Maps Embed                          | In-app place iframe                              | `VITE_GOOGLE_EMBED_KEY` (client-visible)                        | Browser iframe                                                     |
| SeatGeek                                   | Event discovery                                  | `SEATGEEK_CLIENT_ID` secret                                     | Relay `GET /events`                                                |
| Eventbrite                                 | Curated OC venue events                          | `EVENTBRITE_API_KEY` secret                                     | Relay `GET /events` fan-out                                        |
| LA Socrata / Santa Monica CKAN / Mobilizon | Keyless event feeds                              | None                                                            | Relay `GET /events` fan-out                                        |
| CARTO / Esri / Google Fonts                | Basemap tiles, satellite imagery, font           | None                                                            | Browser direct                                                     |

## Transitous / MOTIS

`https://api.transitous.org` — worldwide community transit routing.
Endpoints: `api/v2/plan` (journeys), `api/v6/one-to-all` (reachable stops),
`api/v1/map/stops` (viewport stops).

- **No key, no agency whitelist** — OCTA, Metro–Los Angeles, Metrolink, Amtrak
  and other supported feeds work through the same pipeline. Coverage depends
  on the feed and departure time.
- v2 plan geometry is polyline **precision 6** — correct for Southern
  California longitudes; v1's precision-7 is undefined beyond 107°. `decode`
  respects the precision field.
- `one-to-all` returns `duration` and takes `maxTravelTime` in **minutes**.
- `/api/v1/map/stops` lacks agency names — provider labels come from plan
  responses, which name **all** alternatives, not just the fastest.
- The experimental `map/routes` endpoint is too heavy for viewport use
  (~800 kB / 9 s at zoom 13); the corridor glow uses planned leg geometry
  instead.
- **Node gotcha:** Transitous rejects the default Node fetch user-agent with
  403 — set a `User-Agent` header for server-side probing (`worker/` sends
  `TimeTransit/1.0`).
- Walking budgets sent per request: `maxPreTransitTime`,
  `maxPostTransitTime`, `maxDirectTime` (seconds = distance/speed),
  `pedestrianSpeed`, `withDistance=true`, `arriveBy`. Parameter reference:
  `motis-project/motis` `openapi.yaml` on GitHub.

## Photon / OpenStreetMap

`photon.komoot.io` — OSM geocoding and category search.

- `q=` matches **names only**; `include=osm.<key>.<value>` filters by tag
  without name text. This is why `matchCategory` exists — "Walmart" never
  contains "grocery".
- Destination searches use a bounded search area (~20 km); origin geocoding is
  unrestricted. Bare five-digit ZIPs use a US-biased query and require an
  exact postcode match (`90620` → Buena Park, not a foreign street).
- Coverage depends on OSM tagging — not a complete business directory.
- Attribution: © OpenStreetMap contributors. Basemaps: CARTO Dark Matter and
  key-free, CORS-enabled Esri World Imagery + World Boundaries and Places
  (visible attribution required and present). Font: Jockey One via Google
  Fonts.

## OCTA GTFS + GTFS-Realtime

`octa.net/about/about-octa/open-data` — Orange County's open feeds power the
local intelligence layer.

- **Static GTFS:** `octa.net/current/google_transit.zip` (~4 MB: 5,269 stops,
  56 routes, 7,243 trips, 453,744 stop_times; `shapes.txt` present,
  `frequencies.txt` absent). `scripts/build-scan-index.mjs` compiles it to
  `public/scan/octa.json` (~3.4 MB; 146 patterns, 9,946 walk links). **Feed
  window ends 2027-02-13** — re-run the preprocessor before expiry; OCTA
  publishes updated zips on the same page.
- **Realtime:** `api.octa.net/GTFSRealTime/protoBuf/*.aspx` is keyless protobuf
  (served mislabeled `text/html`) with **no CORS** → relayed at `/gtfsrt/*`
  (Vite dev proxy + `worker/transit-relay.js`, which adds a last-good feed
  shield and `x-feed-stale` header). `src/gtfsrt.ts` decodes trip updates and
  service alerts. The alerts path is `servicealerts.aspx` — `alerts.aspx` is a
  404 HTML page. Swiftly mirrors of the same feed need a key (401).
- OCTA offers the feeds free for useful web services, disclaims all
  warranties, and retains ownership — re-read the terms page before shipping
  anything new on top.

## LA Metro API v2 (`api.metro.net`)

Metro's own open-source API ([LACMTA/metro-api-v2](https://github.com/LACMTA/metro-api-v2),
docs at `lacmta.github.io/metro-api-v2`) — their secondary public channel next
to the Swiftly GTFS-RT feed. **Beta:** per `developer.metro.net`, URLs and
field names are subject to change. Keyless, no published terms or rate limits.

- **Working lane — WebSocket vehicle positions** (verified Nov 2026):
  `wss://api.metro.net/ws/{agency_id}/vehicle_positions/{route_codes}` pushes
  each filtered vehicle every ~3 s. `agency_id` is `LACMTA` (bus) or
  `LACMTA_Rail` (rail — A=801, B=802, C=803, E=804, D=805, K=807);
  `route_codes` is a comma-separated list of short codes (a bare `all` is not
  accepted). Payload carries vehicle id, `tripId`, `routeId` (e.g.
  `720-13201` → code `720`), direction, position, bearing, **speed**,
  `currentStopSequence`, `currentStatus` (`IN_TRANSIT_TO`/`STOPPED_AT`),
  `stopId`, timestamp. WebSocket needs no CORS — the browser connects
  directly; `src/metro.ts` opens a short-lived socket, collects the
  quiet-window burst, keeps the newest fix per vehicle, and closes.
- **Dead lanes (verified Nov 2026 — retest before relying on them):**
  the `trip_updates` WebSocket produces zero messages even on busy routes
  over a 40 s window, and the REST real-time mirror (`/trip_detail/*`,
  `/trips/{id}`, `/stop_times/trip_id/{id}`) returns `[]` for live vehicle,
  trip, and route ids taken straight from the position stream. So the API
  currently yields **positions, not predictions** — Metro legs get a live
  marker but no per-stop delay arithmetic from this source.
- `/{agency}/route_overview` works and returns the full route list, but the
  REST side sends **no CORS headers**, so the browser can't consume it —
  `src/metro.ts` derives route codes from legs and constants instead.

## Transit API v4

`external.transitapp.com/v4/public/*` — the [Transit](https://transitapp.com)
app's API; supplies live departure ETAs on selected journeys. Docs:
`api-doc.transitapp.com`.

- **Relay is mandatory for browser use.** The Kong gateway sends **no CORS
  headers even on 401** (verified via OPTIONS + GET probes). Dev:
  `vite.config.ts` proxies `/transit` and stamps `VITE_TRANSIT_API_KEY`
  server-side. Production: `VITE_TRANSIT_RELAY` → the Worker's `/v4/*` route
  injects the `TRANSIT_API_KEY` secret. The key never reaches the bundle.
- **Free tier: 5 calls/min, 1,500 calls/month** — hard ceiling,
  auto-suspension on breach. A live-alternative comparison costs ~3 calls (two
  `nearby_stops` + one batched `stop_departures`), so it's capped at two
  alternatives and throttled to one comparison per 60 s. No monthly-quota
  header exists — count locally.
- `stop_departures` accepts comma-separated `global_stop_id`s (≤100
  documented; a 20-stop batch consumes **one** per-minute quota unit —
  verified) and a `time` UNIX param; ~2 h ahead returns schedule-only
  (`is_real_time:false`).
- `global_stop_id` is `NETWORK:<internal id>` (e.g. `OCTA:64862`) — the suffix
  is **not** the GTFS `stop_id` (`0002`), can't be synthesized from the index,
  so the `nearby_stops` lookup stays.
- Failure model: 401/403/404 → the client disables itself for the session;
  journeys keep working schedule-only. Never hard-depend on it (§2.3 below).

### Transit API terms (transitapp.com/reports/API_terms.pdf)

Highlights to know before shipping — the full PDF is the authority:

- §2.2 allows distributing a public Partner Application, **but** §2.1
  restricts the free tier to "testing purposes or small-scale use" — real
  public scale needs a paid API Agreement.
- §2.4: the 5/min + 1,500/mo limits above; §2.5 prohibits exceeding limits,
  replicating their database, or reverse-engineering.
- §3.1: notify Transit ≥10 business days before going public (they may require
  changes). §3.3: no marketing mentioning Transit without written approval.
- §3.2: the "Powered by Transit" logo must appear wherever API Data is shown —
  done: `transit-api-badge.svg` renders with the live-bus marker, in
  route/place cards showing departures, and on watchdog notices.
- §2.3: access is revocable at will — Transit must stay a graceful-degrading
  enhancement.
- §8.2: no archiving API Data beyond technical cache; the service worker
  deliberately leaves Transit responses uncached. Derived stats (reliability
  observations) are Partner-owned per §8.3.
- §8.4: send no personal data beyond what queries require (lat/lon only).
- §11.2/§11.3: Partner is liable for end-user reliance on API Data and
  indemnifies Transit — an in-app accuracy disclaimer is expected.
- §2.6: any use under our key is deemed ours — the Worker's `ALLOWED_ORIGINS`
  is the quota-theft protection.

## TomTom Search

`api.tomtom.com/search/2/search` (legacy Search API v2 fuzzy search) —
business/address fallback for businesses OSM lacks.

- `VITE_TOMTOM_API_KEY` is **client-visible by design** — restrict the key in
  the TomTom console: domain whitelist (CORS origins) + limit to the Search
  product.
- Free tier: **2,500 Search requests/month**, no card (the old FAQ's "2,500
  non-tile per day" is outdated — pricing page wins). Places Search API v3
  (10k Suggest + 5k Discover + 5k Details/mo) is the upgrade path if the
  ceiling binds. 401/403/429 → self-disables for the session.
- Query is debounced 250 ms, min 3 chars, session-cached; only the typed query
  - origin bias point are sent; results are never persisted (labeled "Places ©
    TomTom").
- Response carries `position.lat/lon` — a suggestion is already a pinnable
  place, no Details round-trip. Keys: `tomtom-<id>`.

## Overture Maps (local business index)

`scripts/build-places-index.mjs` converts an Overture `place` extract into
`public/places/oc.json` (~223k Orange County rows, ~26 MB / 5.7 MB gz,
permanently-closed dropped, lazy + SW-cached). Each row carries `k` (venue
category → `Place.kind`) and `c` (confidence digit 0–9 — an
exists-confidence, **not** a rating → the "Verified places only" filter).

Rebuild:

```bash
overturemaps download --bbox=-118.11,33.39,-117.41,33.95 -f geojson --type=place
node scripts/build-places-index.mjs
```

## Groq + Gemini (`POST /llm`)

Relay-only — prompts and strict JSON schemas live in the worker. Provider
order from `LLM_PROVIDERS` (default `groq,gemini`), one retry per provider on
403/429/5xx. Probe result: Groq 19/20 schema-valid @ ~0.5 s; Gemini ~10/20 with
intermittent 403/503 — Gemini is the fallback, not the primary.

- **Groq `openai/gpt-oss-20b`** structured output (verified against Groq
  docs): `response_format: {type:"json_schema", json_schema:{name,
strict:true, schema}}`, `reasoning_effort:"low"`,
  `include_reasoning:false`, `temperature:1`, `top_p:1`,
  `max_completion_tokens:1024`. Strict mode wants every property in `required`
  (optional fields as `["type","null"]` unions) and
  `additionalProperties:false` on every object.
- **Gemini `gemini-3.5-flash-lite`** generateContent:
  `response_mime_type:"application/json"` + `response_json_schema` + nested
  `thinkingConfig` (`thinking_level` is **not** a top-level field). Do **not**
  send temperature/top_p/top_k — deprecated for this model. Schema must be the
  OpenAPI-3.0 subset: no `additionalProperties`, no `["type","null"]` unions —
  the worker strips them via `geminiSchema()`.
- Tasks: `parse` (free text → anchors/categories/related_terms/min_rating/
  max_price), `rank` ({query, candidates:[{name,kind}]} → ranked_indices),
  `assist` (AdventurePlan; `depart_at`/`return_by` clamped to a rolling ~62-day
  window by schema pattern — models emit `null` out of window rather than
  bending dates; the client's `fresh()` drops leaks anyway), `suggest`
  (intent → ≤6 `{name, area}` place suggestions — niche/out-of-area picks the
  model believes exist; client geocode-verifies every name via Photon before
  it can become a candidate).
- Optional `context` field (≤2000 chars) appends a "Trip context" block to
  any task — `llmContext(origin)` supplies origin name + coords, local time,
  and walk-distance transit corridors. `input` caps: 300 (`parse`/`assist`),
  600 (`suggest`), 4000 (`rank`).
- Any provider failure degrades to ordinary search. Rate caps: 30 req/min/IP +
  800 req/day in-worker.
- Probe: `GROQ_API_KEY=… GEMINI_API_KEY=… node scripts/llm-probe.mjs` →
  `scripts/llm-probe.results.json` (schema validity, latency, semantic
  accuracy).

## Google Places (`/gmaps/*`)

Relay routes, gated on the `GMAPS_API_KEY` secret:

- `GET /gmaps/text` — Text Search, IDs only, 50 km `locationBias` from
  `?lat&lon`.
- `GET /gmaps/details` — rating, rating count, priceLevel, openNow. Google
  terms: rating/price live in a session `Map` only (never persisted); the
  `place_id` may persist (`timetransit.gmaps-ids`, 500 cap). Google fields
  render in panel rows with a visible "Google" label, never on the MapLibre
  canvas.
- Caps: 20 req/min/IP + 850 req/month. `gmapsConfigured()` = relay present;
  flips off for the session on 500 (no key on relay). The Budget filter
  **dims** over-$$ rows — price isn't in the local index, so it can't
  pre-filter.
- Restrict the key by HTTP referrer in the Google Cloud console.
- Separate from `VITE_GOOGLE_EMBED_KEY` (client-visible; enables the
  `GmapsLink` in-app iframe overlay — restrict by HTTP referrer too).

## Events (`GET /events`)

Server-side fan-out, merged/sorted/capped at 40; missing or empty sources fail
quietly.

| Source                         | Credential                  | Notes                                                                                                                          |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SeatGeek                       | `SEATGEEK_CLIENT_ID` (free) | Absent → keyless sources still serve                                                                                           |
| LA city (Socrata `9aw9-mn4p`)  | None                        | Meeting-heavy; freshness varies — stale rows fall outside the date window                                                      |
| Santa Monica (CKAN `a8ecb913`) | None                        | Coords parsed from `address` — CKAN sends no CORS (hence server-side)                                                          |
| Mobilizon                      | None                        | GraphQL                                                                                                                        |
| Eventbrite curated OC venues   | `EVENTBRITE_API_KEY`        | `/venues/{id}/events/` is still public — `/events/search/` was shut down Dec 2019; ~6 h in-worker cache; seed list `EB_VENUES` |

Rate caps: 10 req/min/IP + 400 req/day. Client: `src/events.ts`; the
assistant's `resolveEventStops` token/distance-matches event stops, degrading
to `category` with a visible note on no match.

## Failure model

- **Silent self-disable:** Transit (401/403/404), TomTom (401/403/429), Google
  Places (500), sync (no config → never called; relay 503s without
  `TT_SYNC_TOKEN` — expected). Optional features vanish; core keeps working.
- **Ordered fallback:** `liveSource.ts` chains providers with a 60 s per-source
  cooldown and timeout-bounded calls; `fallbackEta.ts` keeps ETAs coming from
  index schedule + GTFS-RT delay when live providers are down. Provider order
  is context-aware — local index/relay first for planning and boards, Transit
  first for guidance/tracking.
- **Visible failures:** Photon/MOTIS errors surface as-is — no synthetic
  results. Public services can be slow, unavailable, or rate-limited; a slow
  `one-to-all` (2.5 s race) just skips pre-ranking.
- **Caching:** all external JSON shares the ≤3-concurrency queue and a 500-cap
  in-memory session cache; SW keeps Transit responses uncached (terms), while
  Photon/Transitous get NetworkFirst 24 h and the scan/places indexes get
  StaleWhileRevalidate 7 d.
