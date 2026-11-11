# AGENTS.md — TimeTransit

Guidance for agents reviewing or modifying this repository.

## What this is

A map-first, key-free transit explorer. It ranks nearby places by real
door-to-door journey time (walk + wait + ride + transfers), not distance.
Single-page Vite + React 19 + TypeScript app; **no backend, no accounts**.
All persistent state lives in `localStorage`. Optional Transit API
(transitapp.com) integration adds live departure ETAs to selected journeys.

## Commands

On Windows use `npm.cmd` / `npx.cmd` (the Git Bash npm shim is unreliable here).

- `npm install`
- `npm run dev -- --port 5173`
- `npm run build` — `tsc -b && vite build`; emits an installable PWA to `dist/`
- `npx vitest run` — unit tests; two live-API suites skip unless `LIVE=1`
- `npx prettier --check .` / `npm run format` — formatting is enforced

Verify any change with `npx.cmd tsc -b` + `npx.cmd vitest run` before calling it done.

## Environment

`.env.local` (gitignored; `.env*` is in `.gitignore` — do not bypass that):

- `VITE_TRANSIT_API_KEY` — Transit app API key (docs: api-doc.transitapp.com).
  Stamped onto requests by the dev proxy; never reaches the bundle.
- `VITE_TRANSIT_RELAY` — production relay URL (Cloudflare Worker). When set,
  the client calls it directly instead of `/transit`. Empty → `/transit` dev proxy.

## Architecture

| File | Role |
| --- | --- |
| `src/api.ts` | Transitous/MOTIS `v2/plan` + `v1/map/stops`, Photon geocoding. Module-level fetch queue (≤3 concurrent), URL-keyed session cache (500 cap), AbortSignal plumbing. |
| `src/transit.ts` | Transit API client: `nearby_stops` → `stop_departures` → matched live ETA per leg. Pure matchers (`normalizeName`, `routeScore`, `pickDeparture`, `nearestStop`) are exported for tests. Disables itself for the session on 401/403/404 (no key/relay). |
| `src/core.ts` | Pure logic only: `distance`, `fastest`, `rank`, `decode`, `combinations`, `optimize`; category chips + `matchCategory` fuzzy resolver (synonyms → OSM tags, stopword stripping, edit-distance tolerance by word length). |
| `src/useTimeTransit.ts` | Controller hook. `run(term)` splits on `+`: 1 segment → explore stream; 2–4 → multi-stop optimizer (shared dwell, optional round trip, pinned places from "Add to trip"). Live-departure enrichment fires on `selected`. |
| `src/reliability.ts` + `src/reliabilityStore.ts` | Observation model (`observation`, `observationId`, `mergeObservations`, weighted `statistics`), localStorage persistence (10k cap), GPS-vs-feed weighting, simulated-data quarantine. |
| `src/boarding.ts`, `useTripTracking.ts`, `TripTracker.tsx` | Opt-in `watchPosition` boarding detector and `?simulate=1` lab. |
| `src/Panel.tsx`, `ResultsList.tsx`, `MapLayer.tsx`, `Hud.tsx` | UI: panel/origin/departure, unified search box + `+` options row + chain timeline, MapLibre map + geolocate control, journey HUD. |
| `src/display.ts`, `preferences.ts`, `storage.ts`, `tripCandidates.ts` | Small helpers: formatting, walk prefs/origin persistence, guarded storage, candidate resolution. |
| `worker/transit-relay.js` | Cloudflare Worker: forwards GETs to `external.transitapp.com` with `apiKey` from env secret; origin-allowlisted CORS. |
| `vite.config.ts` | Dev proxy `/transit` → Transit API (injects key server-side) + `vite-plugin-pwa` (manifest, generateSW, runtime caching). |

## Conventions

- **Secrets never ship**: only `VITE_*` vars reach the bundle; the Transit key
  lives server-side (dev proxy or Worker env secret). `.env*` is gitignored —
  edit it via shell if tooling refuses.
- **No synthetic fallbacks**: public services fail visibly; missing data fields
  are never invented. Transit features degrade silently (the app predates the key).
- **Compact code**: terse TS matching surrounding style; no explanatory comments.
- **Pure logic in `core.ts`/`transit.ts` matchers**, React/network at the edges —
  that's what makes it testable. Keep it that way.
- **Tests mock `fetch`** (vitest `vi.spyOn`). `api.ts`'s module-level cache
  persists across tests in one file — use distinct queries/origins per test.
- Guard every browser API (`localStorage`, `geolocation`, `AbortSignal`) —
  tests run without a DOM.

## Verified facts (receipts, don't re-derive)

- Transit API v4: `https://external.transitapp.com/v4/public/*`, `apiKey` header.
  Gateway (Kong) returns **no CORS headers** even on 401 — verified via
  OPTIONS + GET probes; a relay is required for browser use.
- Photon `q=` matches **names only**; `include=osm.<key>.<value>` filters by
  tag. This is why the fuzzy matcher exists — "Walmart" never contains "grocery".
- MOTIS v2 plan geometry uses polyline precision 6 (v1's precision-7 is
  undefined beyond 107° longitude).
- Cloudflare Workers free plan: 100k requests/day — far above this relay's load.

## Watch out

- Transit free-key quota is small; each journey selection costs ~1–2 relay
  requests per transit leg.
- Service worker caches app shell, basemap tiles, fonts; plan/search data is
  NetworkFirst with 24 h fallback; Transit API responses are deliberately uncached.
- Geolocation needs a secure context (HTTPS or localhost) — the installable PWA
  must be served over HTTPS.
- `npm install` may warn about esbuild's postinstall under allow-scripts —
  harmless for local dev.
- `MultiStopPlanner.tsx` was removed when `+` syntax replaced the tab UI; don't
  resurrect it — extend the single search box instead.
