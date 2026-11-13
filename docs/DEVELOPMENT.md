# Development

Build, test, data-pipeline, and troubleshooting reference. For architecture
see [ARCHITECTURE.md](ARCHITECTURE.md); for provider details see
[API-INTEGRATIONS.md](API-INTEGRATIONS.md).

## Commands

Node.js 22.12+ recommended. **On Windows use `npm.cmd` / `npx.cmd`** — the
Git Bash npm shim is unreliable in this environment.

```bash
npm install              # deps
npm run dev -- --port 5173   # dev server → http://localhost:5173
npm run build            # tsc -b && vite build → dist/ (installable PWA)
npx vitest run           # unit tests
npm run format           # prettier --write . (enforced: npx prettier --check .)
```

Verify any change with `npx.cmd tsc -b` + `npx.cmd vitest run` before calling
it done.

## Environment variables

`.env.local` at repo root — gitignored (`.env*` is in `.gitignore`; do not
bypass that, and edit it via shell if tooling refuses).

| Var                     | Effect                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `VITE_TRANSIT_API_KEY`  | Dev proxy stamps it on `/transit/*`; never reaches the bundle                                                   |
| `VITE_TRANSIT_RELAY`    | Production relay URL; empty → `/transit` dev proxy. Baked at build time — set before `npm run build`            |
| `VITE_TOMTOM_API_KEY`   | Client-visible TomTom Search key; restrict by domain whitelist + Search product. Absent → fallback silently off |
| `VITE_GOOGLE_EMBED_KEY` | Client-visible; enables `GmapsLink` in-app iframe. Absent → link-only                                           |
| `VITE_BASE`             | Vite base path, default `/TimeTransit/` — see the MSYS trap below                                               |

The dev server also proxies `/api/*` → the deployed relay
(`transit-relay.charlesdvaught-34c.workers.dev`), so the relay-side routes
(arrivals, health, state sync) work locally without a local worker.

Worker env (never bundled; secrets via `wrangler secret put`, plain values as
`[vars]` in `worker/wrangler.toml`): `TRANSIT_API_KEY`, `ALLOWED_ORIGINS`,
`GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_PROVIDERS`, `GMAPS_API_KEY`,
`SEATGEEK_CLIENT_ID`, `EVENTBRITE_API_KEY`, `TT_SYNC_TOKEN`, `SITE_KEY` (site
worker). Local worker dev: `worker/.dev.vars` (gitignored). Details in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Tests

- **Unit:** `npx vitest run` — vitest, tests colocated in `src/`. Mock
  `fetch` with `vi.spyOn`; `api.ts`'s module-level session cache persists
  across tests in one file — use distinct queries/origins per test. Guard
  every browser API (`localStorage`, `geolocation`, `AbortSignal`) — tests
  run without a DOM.
- **Live API (opt-in):** `LIVE=1 npx vitest run` enables the live suites
  (`src/live.test.ts`, `src/keystone.live.test.ts`,
  `src/categories.live.test.ts`, `src/spotcheck.test.ts`) — they hit real
  Transitous/Photon/OCTA endpoints. Scan-vs-MOTIS receipt:
  `LIVE=1 npx vitest run src/spotcheck.test.ts`.
- **E2E:** Playwright, mobile-viewport only (`tests/e2e/` — iPhone 14 Pro +
  Pixel 7 with mocked Long Beach geolocation; dev server auto-starts at
  `baseURL http://localhost:5173/TimeTransit/`). `mobile-sheet.spec.ts` covers
  the bottom-sheet states; `smoke.spec.ts` the happy path. Vitest excludes
  `tests/e2e/**`.

## Data preprocessing

Three build-time scripts turn public transit/POI data into the lazy-loaded
indexes under `public/` (SW-cached, not precached). `data/` (gitignored) holds
the raw sources.

| Script                            | Input → output                                                                                                    | Regen                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-scan-index.mjs`    | OCTA GTFS zip/dir → `public/scan/octa.json` (patterns, trips, calendars, walk links; ~3.4 MB)                     | `node scripts/build-scan-index.mjs <gtfs-dir-or-zip>` — **before the feed window ends (2027-02-13)**                                                                                           |
| `scripts/build-places-index.mjs`  | Overture `place` extract → `public/places/oc.json` (~223k OC rows)                                                | `overturemaps download --bbox=-118.11,33.39,-117.41,33.95 -f geojson --type=place` then run the script                                                                                         |
| `scripts/build-network-layer.mjs` | GTFS shapes → `public/scan/network.json` (polyline-6 lines + ~17.3k stop dots, OCTA + LA Metro bus/rail, ~1.3 MB) | `node scripts/build-network-layer.mjs "data/octa,e95420" "data/metro-bus,0060a8" "data/metro-rail,e4002b" public/scan/network.json` (Metro GTFS: `gitlab.com/LACMTA/gtfs_{bus,rail}`, keyless) |
| `scripts/llm-probe.mjs`           | 20 canned queries at Groq + Gemini with the exact relay payloads → `scripts/llm-probe.results.json`               | `GROQ_API_KEY=… GEMINI_API_KEY=… node scripts/llm-probe.mjs`                                                                                                                                   |

**GTFS CSV gotcha:** fields are quoted — a naive `split(",")` silently
corrupts rows. `build-network-layer.mjs` has a real CSV parser; keep it.

## Conventions

- **Secrets never ship:** only `VITE_*` vars reach the bundle; server-side
  keys live in the dev proxy or Worker secrets.
- **No synthetic fallbacks:** public services fail visibly; optional
  integrations degrade silently.
- **Compact code:** terse TS matching surrounding style; no explanatory
  comments.
- **Pure logic in `core.ts`/`scan.ts`/matchers;** React/network at the edges.
- `MultiStopPlanner.tsx` was removed when `+` syntax replaced the tab UI —
  don't resurrect it; extend the single search box instead.
- New app map layers must use an `APP_LAYER_PREFIXES` prefix (or be added to
  it) to survive the minimized riding-view filter.
- `runExplore` honors a pinned place for the exact searched text (how a
  TomTom suggestion becomes a destination OSM doesn't know).

## Troubleshooting & gotchas

- **MSYS/Git Bash `VITE_BASE` trap:** `VITE_BASE=/ npm run build` gets
  path-converted to `/Program Files/Git/` → deployed assets 404 (black
  screen). Use `MSYS_NO_PATHCONV=1 VITE_BASE=/ npm run build`, then confirm
  `dist/index.html` shows the right base.
- **Git identity unset on this machine:** pass `-c user.name=… -c
user.email=…` per commit; set `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for
  `npx gh-pages` (it spawns plain `git commit`).
- **`npm install` may warn** about esbuild's postinstall under allow-scripts —
  harmless for local dev.
- **Geolocation needs a secure context** (HTTPS or localhost); the PWA must be
  served over HTTPS.
- **Transitous 403s the default Node fetch UA** — set a `User-Agent` for
  server-side probing.
- **OCTA GTFS-RT has no CORS** — `/gtfsrt` dev proxy or relay required; the
  alerts path is `servicealerts.aspx` (`alerts.aspx` 404s).
- **Transit API has no CORS even on 401** — browser calls always go through a
  relay; without one the feature self-disables.
- **Each Explore search adds one `one-to-all` request** (cached per
  origin+departure, 2.5 s race → distance-order fallback) — a slow
  reachability query never blocks results.
- **Transit free-tier quota:** 5 calls/min + 1,500 calls/mo; each journey
  selection costs ~1–2 relay calls per transit leg; the alternative
  comparison is throttled to stay under the per-minute ceiling.
- **npm `overrides` force two build-time dep fixes** (Dependabot): `glob`
  → `minimatch@11.0.4` (globparts-amplification ReDoS, fixed 11.0.1) and
  `workbox-build` → `glob@14.0.2` (AbortSignal bypass). Both only run inside
  `vite-plugin-pwa` at build time on our own static globs — verified by
  `npm run build` (workbox generates `dist/sw.js` fine under the forced
  majors). **`deepmerge@4.3.1` remains flagged** (prototype poisoning, no
  patch exists, latest `@rollup/plugin-node-resolve` still requires it) —
  accepted: it only merges our own `vite.config.ts` PWA options at build
  time, so the attacker-controlled-source precondition can't be met. Re-check
  on the next `vite-plugin-pwa`/workbox release.
- **Service worker** caches app shell, basemap tiles, fonts; plan/search data
  is NetworkFirst with 24 h fallback; Transit responses deliberately uncached.
- **Cloudflare dashboard drag-upload refuses JS Worker projects** — use
  `npx wrangler deploy`.
- **`/api/state` 503s without `TT_SYNC_TOKEN`** on a self-hosted relay —
  expected, not a bug.
