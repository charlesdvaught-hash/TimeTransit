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

## Explore

Allow location access, search an origin address, or use the pin button then click the map. Chicago is the fallback. Choose a category or business name and optionally a departure date/time. Candidates are restricted to approximately 20 km, deduplicated, distance-prefiltered, and capped at 20. Each result uses the fastest Transitous itinerary including direct walking. Times include walking, waiting, rides, and transfers; arrival times use your browser timezone. Select a result for its colored route and expandable leg details. Route geometry respects MOTIS's encoded-polyline precision field (currently often 7).

## Multi-stop optimizer

Add 2–4 specific results or arbitrary “any matching place” search terms (including category names). Set each dwell duration (default 15 minutes) and optional return to start. For any-stop searches, distance-prefilter six candidates then retain the best three by real time from origin. The pure optimizer enumerates all stop orders and candidate choices; scores these cheaply using haversine distance and effective transit speed calibrated from already-loaded results (18 km/h fallback); verifies at most five estimated-best combinations sequentially with actual plans. Each leg departs at the previous actual arrival plus dwell, including dwell at the last stop. The winning complete trip is selected by elapsed duration including dwell and return. This is a bounded heuristic, not an exhaustive guarantee of a global optimum. Failed complete combinations are skipped; if none work the API error is shown. Unit tests cover normal, empty, error, geometry, ranking, walking and chained-time behavior.

## Public services & limitations

- **Transitous / MOTIS 2** `https://api.transitous.org/api/v1/plan`: worldwide community transit routing, local agency names aggregated automatically from actual itineraries. `/api/v1/map/stops` is queried near the origin; its current response has stop names/modes but no agency names, so provider labels rely on routing results. OpenAPI at `/openapi.yaml` returned 404 during development. No provider selection or keys required.
- **Photon / komoot**: OpenStreetMap geocoding and category search, using `osm_tag` filters and a bounded search area. Coverage depends on OSM tagging; results are not a complete business directory. Address search is local to the same area; map navigation can relocate anywhere.
- **OpenStreetMap contributors**: place, pedestrian and street data, © OpenStreetMap contributors, https://www.openstreetmap.org/copyright.
- **CARTO** Dark Matter basemap, https://carto.com/attributions; **MapLibre GL JS** rendering. Attribution remains on the map.
- **Inter** via Google Fonts (system font fallback).

No backend, secrets, analytics or persisted location history. Requests transmit coordinates and search terms to the public providers. All external JSON requests share a maximum-three concurrency queue, bounded in-memory response cache and cancellation for stale searches/origin changes. A new search uses a fresh departure timestamp; cache lasts the current page session. Public services can be slow, unavailable or rate limited; visible errors are not synthetic fallback results. Geolocation requires permission and HTTPS or localhost. Mobile uses a scrollable bottom panel. Map/network access requires internet.
