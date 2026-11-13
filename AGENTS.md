# AGENTS.md — TimeTransit

## What this is

A map-first, key-free transit explorer. It ranks nearby places by real
door-to-door journey time (walk + wait + ride + transfers), not distance.
Single-page Vite + React 19 + TypeScript app; **no backend, no accounts**.
All persistent state lives in `localStorage`. Optional Transit API
(transitapp.com) integration adds live departure ETAs to selected journeys.

## Documentation

Developer documentation lives in `docs/` (user-facing intro: `README.md`).
The docs carry the prose explanations and the verified provider/build
receipts; this file keeps the agent-facing conventions plus a pointer to
each authoritative home — edit the doc for facts, this file for
conventions:

- `docs/ARCHITECTURE.md` — modules, data flow, state management, UI
  structure
- `docs/ALGORITHMS.md` — reachability scan, ranking, multi-stop optimizer,
  transfer risk, reliability, GPS detection, watchdog
- `docs/API-INTEGRATIONS.md` — every provider, credentials, quotas, relays,
  failure handling, Transit API terms
- `docs/DEPLOYMENT.md` — static app, relay + site workers, Access, KV,
  hosted-vs-self-hosted, OBA plan
- `docs/DATA-AND-PRIVACY.md` — localStorage keys, sync, GPS, caching,
  retention
- `docs/DEVELOPMENT.md` — commands, env vars, tests, data preprocessing,
  troubleshooting

## Commands

On Windows use `npm.cmd` / `npx.cmd` (the Git Bash npm shim is unreliable here).

- `npm install`
- `npm run dev -- --port 5173`
- `npm run build` — `tsc -b && vite build`; emits an installable PWA to `dist/`
- `npx vitest run` — unit tests; two live-API suites skip unless `LIVE=1`
- `npx prettier --check .` / `npm run format` — formatting is enforced

Verify any change with `npx.cmd tsc -b` + `npx.cmd vitest run` before calling it done.

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

## Pointers (canonical detail lives in docs/)

The sections below were folded into the docs during the documentation
split. Keep the stubs — they route agents to the right file.

### Environment

Env-var reference → `docs/DEVELOPMENT.md` (client `VITE_*` + worker
secrets). Non-negotiables: `.env*` is gitignored — never commit it; only
`VITE_*` vars reach the bundle and are baked at build time — set them
before `npm run build`.

### Architecture

Module map, data flow, state hooks, UI structure →
`docs/ARCHITECTURE.md`.

### Verified facts

Provider and build receipts → `docs/API-INTEGRATIONS.md` +
`docs/DEVELOPMENT.md`. Check the doc before repeating an empirical claim —
and update it there.

### Transit API terms

Digest → `docs/API-INTEGRATIONS.md` (quotas, attribution, caching, liability).
The full PDF (transitapp.com/reports/API_terms.pdf) is the authority — read
before shipping.

### Watch out

Gotchas → `docs/DEVELOPMENT.md` troubleshooting (MSYS `VITE_BASE` trap,
CORS-less feeds, Transit quotas, service-worker policy, removed
`MultiStopPlanner.tsx`, esbuild warning, secure-context geolocation).

### Wave notes (Nov 2026)

Wave-1 storage/sync additions + Waves 2–3/mobile details →
`docs/ARCHITECTURE.md` + `docs/DATA-AND-PRIVACY.md`. Storage keys are
`tt_bookmarks_v1`, `tt_recent_searches_v1`, `tt_favorite_lines_v1`,
`tt_last_plan_cache_v1`, `tt_worker_sync_v1` — the docs' inventory is
canonical.

### OneBusAway plan (decided, not built)

Summary + pointers → `docs/DEPLOYMENT.md`. Full decision trail:
`onebusawaybrainstorm.txt`; runbook: `deploy/oba/README.md`. Live ETAs
today still come from `src/transit.ts` + `src/gtfsrt.ts`; `liveSource.ts`'s
`"oba"` chain entry is the integration seam.
