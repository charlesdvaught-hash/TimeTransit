# TimeTransit

A map-first, key-free transit explorer. Find coffee, groceries, businesses, and everyday places by actual door-to-door journey time, not just distance. Walking alternatives compete with transit. Results stream in as plans arrive.

## Run

Node 22.12+ recommended. On this Windows environment use `npm.cmd` / `npx.cmd` instead of the Git Bash npm shim.

```
npm install
npm run dev -- --port 5173
npm run build
npx vitest run
```

Opt-in real API check: `LIVE=1 npx vitest run src/live.test.ts` (Git Bash; use npx.cmd here).

### Installable app (PWA)

`npm run build` produces an installable PWA in `dist/` — manifest, icons, and a service worker are generated automatically. Serve `dist/` from any HTTPS host (Vercel, Netlify, GitHub Pages…), open it in Chrome on Android, and use "Add to Home Screen" / "Install app" for a standalone launcher. The service worker precaches the app shell, caches basemap tiles and fonts long-term, and keeps transit/search data network-first with a 24 h fallback — so the map and app chrome still load offline, but journeys always prefer live data. Dev mode is unaffected.

### Optional: Transit API key

Live departure estimates on selected journeys use the [Transit API](https://api-doc.transitapp.com/) when a key is present. Put `VITE_TRANSIT_API_KEY=...` in `.env.local` (gitignored) and restart `npm run dev`. The dev server relays `/transit/*` requests to `external.transitapp.com` and stamps the key server-side, so it never reaches the browser bundle — this also works around the API's lack of CORS headers. Without a key, or if the key is rejected, journeys work as before with schedule-only times. Each selection of a journey costs roughly one request per transit leg (stop lookup + departures), so free-tier quotas can be exhausted with heavy clicking.

**Outside dev** (the installed PWA), there is no dev proxy — point the app at a relay via `VITE_TRANSIT_RELAY` in `.env.local` at build time (e.g. `VITE_TRANSIT_RELAY=https://transit-relay.you.workers.dev`). A ready-made relay lives in `worker/transit-relay.js`: on Cloudflare's free plan (100k requests/day, no card), Workers & Pages → Create Worker → paste the file → Deploy, then set two variables under Settings → Variables: `TRANSIT_API_KEY` (type: secret) and `ALLOWED_ORIGINS` (comma-separated origins allowed to call it — your app's HTTPS origin and `http://localhost:5173`). Only listed origins get a usable CORS answer, so a stranger finding the URL can't drain your key from a browser. CLI alternative: `npx wrangler deploy` from `worker/` after `wrangler secret put TRANSIT_API_KEY`.

## Explore

Allow location access, search an origin address, or use the pin button then click the map. Location can be granted from the browser prompt on first visit, the "Use my location" action under the origin card, or the crosshair control on the map's top-right; denial explains how to re-enable it in site settings. Chicago is the fallback. Choose a category or business name and optionally a departure date/time. Free-text searches fuzzy-match against category synonyms (so "groery store" or "urgent care" resolve to OSM tags like `shop:supermarket`) and merge tag-filtered results with name matches — places like Walmart surface even though their names never say "grocery". Candidates are restricted to approximately 20 km, deduplicated, distance-prefiltered, and capped at 20. Each result uses the fastest Transitous itinerary including direct walking. Times include walking, waiting, rides, and transfers; arrival times use your browser timezone. Select a result for its colored route and expandable leg details. Route geometry respects MOTIS's encoded-polyline precision field (6 for the v2 plans used here).

## Walking preferences and origin

Walking preferences persist locally: 800 m per walking leg by default (200–2,000 m) and a selectable walking speed (m/s). Changes invalidate journeys; search again to recompute. MOTIS receives `maxPreTransitTime`, `maxPostTransitTime`, and `maxDirectTime` in seconds, computed as distance / speed, plus `pedestrianSpeed` and `withDistance=true`. These are street-routing time budgets, not exact distance guarantees. Returned walking legs exceeding the distance are visibly flagged, including transfers; if distance is absent, duration × speed is used. The current OpenAPI has no maximum transfer-walk-distance parameter, so transfer walks are checked locally, not silently dropped.

The last origin is saved locally. Origin geocoding is separate from nearby destination search (no 20 km restriction). Bare five-digit ZIPs use a US-biased Photon query and require an exact postcode match, so `90620` resolves to Buena Park rather than a similarly numbered street abroad.

## Local reliability and optional boarding estimates

Every plan response records all realtime transit-leg departure estimates, including alternatives. Identity is agency ID + route ID; observations are deduplicated by trip ID + stop ID + source. GPS supersedes a feed estimate for the same trip/stop, and otherwise carries 3× the weight of feed data. Statistics show distinct departure-sample count, weighted median delay, and weighted early/on-time/late percentages. More than 60 seconds early or more than 300 seconds late is outside the on-time window. With at least five distinct trip/stop samples, under 70% on time or a median outside that window flags a route as “Runs early” or “Often late.” These are local, potentially biased estimates—not a universal reliability rating. Arrivals are recorded separately but are not used to penalize early departures. Repeated feed polls do not inflate sample counts.

“Start trip · GPS” requests `watchPosition` only on demand. For each transit leg, including multi-stop/return legs, the detector waits near boarding (75 m + capped accuracy allowance), then requires >4 m/s measured motion for at least 20 seconds within about 60 m of the route geometry. Departure is timestamped at the first qualifying fix outside the stop area, not when confirmation finishes. Arrival requires sustained slowing near the exit or walking off the polyline. Fixes with >50 m uncertainty, stale timestamps, and large gaps do not establish boarding. Missing route geometry or schedule disables tracking with a visible explanation. GPS alone cannot distinguish parallel routes or prove boarding: manual trip selection and foreground GPS are required. Permission denial, background suspension, tunnels and sparse fixes may prevent detection. No raw GPS trace is saved.

Open `/?simulate=1` to reveal the simulation lab in the journey HUD. Pick any selected bus/train leg and a signed delay in minutes, then replay a synthetic GPS trace through the same detector. “Seed 5 demo trips” can demonstrate a reliability flag (choose −2 min or >5 min; +4 min is on time by the configured window). Synthetic observations are tagged and excluded from real badges/stats; enable “Show simulated data only” in Route reliability to inspect them. Demo identities are reused so repeated seeding does not artificially multiply samples.

Observations, preferences and last origin stay in this browser’s localStorage; no account or upload. Data is capped at 10,000 observations. The Reliability panel lists route and stop stats and has a clear-data button. Storage failures display a warning; in-memory use still works. Feed delays are predictions, GPS delays are estimates, and missing schedule/identity fields are not invented.

## Multi-stop optimizer

Separate destinations with `+` in the one search box — e.g. `coffee + pharmacy + home depot` — to plan a multi-stop trip (2–4 stops). Any term can be a category-like phrase or a place name; “Add to trip” on a result appends its name and pins that exact place. A shared stay duration (default 15 minutes) and optional round trip appear when the box holds multiple destinations. For free-text stops, distance-prefilter six candidates then retain the best three by real time from origin. The pure optimizer enumerates all stop orders and candidate choices; scores these cheaply using haversine distance and effective transit speed calibrated from already-loaded results (18 km/h fallback); verifies at most five estimated-best combinations sequentially with actual plans. Each leg departs at the previous actual arrival plus dwell, including dwell at the last stop. The winning complete trip is selected by elapsed duration including dwell and return. This is a bounded heuristic, not an exhaustive guarantee of a global optimum. Failed complete combinations are skipped; if none work the API error is shown. Unit tests cover normal, empty, error, geometry, ranking, walking and chained-time behavior.

## Code layout

- `src/api.ts` — Transitous/MOTIS journey planning + Photon geocoding; shared 3-way concurrency queue, session cache, abort handling.
- `src/transit.ts` — Transit app API client (live departures): boarding-stop lookup, route/headsign/schedule matching, relay-aware (`VITE_TRANSIT_RELAY` or `/transit` dev proxy), self-disabling when the key/relay is absent.
- `src/core.ts` — pure logic only: distance, ranking, polyline decode, category chips, fuzzy category matcher (synonyms + edit distance + stopwords), multi-stop optimizer.
- `src/useTimeTransit.ts` — the controller: all app state, explore vs `+`-separated multi-stop runs, live-departure enrichment, pinned places.
- `src/reliability*.ts`, `src/storage.ts` — observation model, dedupe, weighted statistics, localStorage persistence.
- `src/boarding.ts`, `src/useTripTracking.ts`, `src/TripTracker.tsx` — opt-in GPS boarding detector + simulation lab.
- `src/Panel.tsx`, `src/ResultsList.tsx`, `src/MapLayer.tsx`, `src/Hud.tsx` — UI shell, unified search/results/timeline, map, journey HUD.
- `worker/transit-relay.js` — Cloudflare Worker relay for the Transit key outside dev.
- `vite.config.ts` — dev proxy for the Transit key + PWA plugin (manifest, service worker).

## Public services & limitations

- **Transitous / MOTIS 2** `https://api.transitous.org/api/v2/plan`: worldwide community transit routing. v2 supplies precision-6 geometry valid for Southern California longitudes (v1 precision-7 geometry is undefined beyond 107° longitude). Provider names include all plan alternatives, not just the fastest choice. No agency whitelist: OCTA, Metro - Los Angeles, Metrolink, Amtrak and other supported bus/train feeds work through the same pipeline. Service and realtime coverage depend on the feed and departure time. `/api/v1/map/stops` currently lacks agency names; provider labels come from plan responses. Parameter reference: https://github.com/motis-project/motis/blob/master/openapi.yaml.
- **Photon / komoot**: OpenStreetMap geocoding and category search, using `include=osm.key.value` without name text and a bounded search area for destinations. Coverage depends on OSM tagging; results are not a complete business directory. Origin search can relocate anywhere.
- **OpenStreetMap contributors**: place, pedestrian and street data, © OpenStreetMap contributors, https://www.openstreetmap.org/copyright.
- **CARTO** Dark Matter basemap, https://carto.com/attributions; **MapLibre GL JS** rendering. Attribution remains on the map.
- **Inter** via Google Fonts (system font fallback).

No backend, secrets, analytics or raw GPS history. Last origin and stop-level reliability observations persist locally as described above. Requests transmit journey coordinates and search terms to the public providers, not the GPS trace. All external JSON requests share a maximum-three concurrency queue, bounded in-memory response cache and cancellation for stale searches/origin changes. A new search uses one departure snapshot; cache lasts the current page session. Public services can be slow, unavailable or rate limited; visible errors are not synthetic fallback results. Geolocation requires permission and HTTPS or localhost. Mobile uses a scrollable bottom panel. Map/network access requires internet.
