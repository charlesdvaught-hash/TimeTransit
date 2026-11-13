# Architecture

TimeTransit is a single-page application: Vite + React 19 + TypeScript, no
backend, no accounts. All persistent state lives in `localStorage`. Two
optional Cloudflare Workers provide the integrations a browser cannot do
key-free or CORS-free (see [DEPLOYMENT.md](DEPLOYMENT.md)). Everything on this
page is the client unless noted.

## Design rules

- **Pure logic at the core, network/React at the edges.** `core.ts`, `scan.ts`,
  `watchdog.ts`, `transferRisk.ts`, `reliability.ts`, and the matchers in
  `transit.ts` are pure functions — that is what makes the ranking, optimizer,
  and detection code unit-testable. Keep it that way.
- **No synthetic fallbacks.** Public services fail visibly; missing data fields
  are never invented. Optional features (Transit API, TomTom, LLM, Google
  Places) degrade silently — the app predates every one of them.
- **Secrets never ship.** Only `VITE_*` variables reach the bundle. Keys that
  must stay server-side live in the dev proxy or Worker secrets.
- **Bounded everything.** One module-level fetch queue (≤3 concurrent), a
  URL-keyed session cache (500 entries), `AbortSignal` plumbing on every
  request, and caps on stored state (4 bookmarks, 8 recents, 32 favorites,
  10k observations).

## Data flow — explore search

```
term ──► suggestions merge ──► candidate set ──► reachability pre-rank ──► plan ──► results
        (local index + Photon      (~20 km,        (one-to-all: reach a      (MOTIS
         + TomTom, publish once)    deduped)        stop ≤1.5 km + walk)      top ~20)
```

1. `Panel.tsx` collects the term; `suggestions.ts` merges local Overture rows,
   Photon tag/name hits, and TomTom results, scored by name relevance. Results
   publish **once** (1.4 s cap, shimmer meanwhile) — no partial-result flicker.
   An "All ~N matches" row keeps category searches generic.
2. `useTripSearch.run(term)` resolves candidates: free text fuzzy-matches
   category synonyms → OSM tags (`matchCategory` in `core.ts`) and merges
   tag-filtered results with name matches, so "groery store" and "Walmart"
   both work.
3. Candidates are bounded to ~20 km, deduplicated, and pre-ranked by MOTIS
   `one-to-all` reachability — reach time to a stop within 1.5 km plus a walk
   at the configured speed — inside a 2.5 s race. Unavailable → distance order.
4. The best ~20 are planned exactly with `api.plan` (MOTIS v2). A pinned
   place for the exact searched text (e.g. a TomTom pick) is honored even when
   OSM has no such business.
5. With AI assistance enabled, `semantic.ts` may add a `parse` call up front
   (free text → concrete terms + constraints) and a `rank` call that reorders
   the reachability candidates before the plan calls — display order stays
   journey-time either way.

## Data flow — multi-stop trip (`+` syntax)

2–4 `+`-separated terms become a chained trip. `resolveTripCandidates`
(`tripCandidates.ts`) ranks each stop's prospects with `candidateTimer`
estimates — local scan inside OCTA coverage, `one-to-all` outside, a real
`plan()` only for what estimates can't see — keeping a best-six `pool` plus up
to fourteen `alternates` per stop. `scanOrder` beam-ranks stop combinations
over the scan index (real bus paths, not haversine — outside coverage a
haversine heuristic applies). `optimizeKeystones` (`core.ts`) plans ≤3 route
cards anchored on the rarest stop, convenience-scored; displayed routes are
verified with real chained MOTIS plans. Details in
[ALGORITHMS.md](ALGORITHMS.md#multi-stop-optimizer).

## Data flow — live departures & guidance

`liveSource.ts` maintains an ordered provider chain
(`oba → transit → octa-rt → index` by name) with a 60 s cooldown per failed
source and timeout-bounded `trySource`. Order is context-aware:
`liveDeparturesChained(mode)` puts local index/relay first for planning and
boards, Transit first for guidance/tracking. `fallbackEta.ts` repackages the
scan index + GTFS-RT "schedule + delay" into the Transit client's shapes, so
the UI can't tell a keyless estimate from a paid one. `transit.ts` is the
Transit API client (`nearby_stops` → batched `stop_departures` → matched ETA
per leg); `gtfsrt.ts` decodes OCTA trip updates and service alerts relayed via
`/gtfsrt/*`.

## State management

`useTimeTransit.ts` is the orchestrator hook: origin/departure state, hover +
pin preview, and wiring for the feature hooks. React state is the source of
truth for the UI; `localStorage` is the persistence layer (see
[DATA-AND-PRIVACY.md](DATA-AND-PRIVACY.md)).

| Hook / module                            | Owns                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useTripSearch.ts`                       | `run(term)` / `runExplore`: single-term explore stream and `+`-separated keystone route cards, dwell/round-trip/pins, LLM-as-judge candidate reordering                                            |
| `useSavedPlaces.ts`                      | Bookmarks, board ETAs, nearby departures, `planToBookmark`                                                                                                                                         |
| `useRecentSearches.ts`                   | Recent-search chips (≤8)                                                                                                                                                                           |
| `useFavorites.ts`                        | Favorite transit lines (≤32)                                                                                                                                                                       |
| `useSyncPush.ts`                         | Ref-linked, event-time pushes of bookmarks/recents/favorites to `/api/state`                                                                                                                       |
| `useTripCache.ts`                        | `writeCachedPlan` on every displayed trip; restores when `navigator.onLine === false`, on empty offline results, or on `TypeError` failures — "Offline — cached trip" pill                         |
| `useTripTracking.ts` + `TripTracker.tsx` | GPS ride mode, boarding detection, watchdog polling                                                                                                                                                |
| `useUserPosition.ts`                     | Permission-gated idle `watchPosition` (starts only after grant or "Use my location")                                                                                                               |
| `preferences.ts`                         | `walkDistance`/`walkingSpeed`, `aiMode` (`"none"`/`"minimal"`/`"full"`, default `"minimal"`), `verifiedOnly`, `budgetOnly` — `loadPreferences` coerces missing/invalid fields so old saves migrate |
| `storage.ts`                             | Typed `readStored`/`writeStored` guards + bookmark/recent/favorite/plan-cache/sync helpers                                                                                                         |
| `contracts.ts`                           | Shared cross-feature types only (`SavedPlace`, `RecentSearch`, `FavoriteLine`, `CachedPlan`, `AdventurePlan`, `SemanticParseResult`, …) — no logic                                                 |

## Module map

| File                                                                                                                                                  | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api.ts`                                                                                                                                          | Transitous/MOTIS `v2/plan`, `v6/one-to-all`, `v1/map/stops` + Photon geocoding. Module-level fetch queue (≤3 concurrent), URL-keyed session cache (500 cap), `AbortSignal` plumbing.                                                                                                                                                                                                                                                                                                                                       |
| `src/core.ts`                                                                                                                                         | Pure logic only: `distance`, `fastest`, `itineraries`, `rank`, `decode` (polyline), `combinations`, `optimize`, `optimizeKeystones`, `suggestCategories`, `matchCategory` fuzzy resolver (synonyms → OSM tags, stopword stripping, edit-distance tolerance by word length).                                                                                                                                                                                                                                                |
| `src/scan.ts`, `src/scanData.ts`                                                                                                                      | Pure RAPTOR-style reachability scan over `public/scan/octa.json` (board → ride → transfer-walk rounds, service calendars, overnight trips, GTFS-RT delay overlay) + lazy loader. Ranks candidates and orders `+` trips inside OCTA coverage; SW-cached `StaleWhileRevalidate`, not precached.                                                                                                                                                                                                                              |
| `src/places.ts`                                                                                                                                       | Overture Maps business POI index (`public/places/oc.json`, ~223k rows, lazy + SW-cached): name-and-kind-scored local hits merged into suggestions; `k` = venue category → `Place.kind`, `c` = confidence digit → `Place.confidence`.                                                                                                                                                                                                                                                                                       |
| `src/transit.ts`                                                                                                                                      | Transit API client: `nearby_stops` → `stop_departures` → matched live ETA per leg. Pure matchers (`normalizeName`, `routeScore`, `pickDeparture`, `nearestStop`) exported for tests. Self-disables for the session on 401/403/404.                                                                                                                                                                                                                                                                                         |
| `src/tomtom.ts` + `src/suggestions.ts`                                                                                                                | TomTom Search v2 fuzzy-search client (coordinates in response, no Details round-trip) + shared suggestion type and name-relevance merge. Debounced 250 ms, min 3 chars, session-cached; disables on 401/403/429.                                                                                                                                                                                                                                                                                                           |
| `src/gtfsrt.ts`                                                                                                                                       | Minimal GTFS-Realtime protobuf decoder → `trip_id → stop_id → {delay,time}` map; delays applied to scan trips departing within ~2 h. Also decodes `servicealerts.aspx` → `ServiceAlert[]`; `alertsFor` matches route/stop for UI badges and normalizes namespaced route ids (`octa:55` matches `55`; `1` never matches `10`).                                                                                                                                                                                              |
| `src/fallbackEta.ts`                                                                                                                                  | Keyless live-ETA fallback: local index schedule + GTFS-RT delay, plus the relay's OBA-shaped `/api/arrivals`, repackaged into Transit-client shapes.                                                                                                                                                                                                                                                                                                                                                                       |
| `src/liveSource.ts`                                                                                                                                   | Ordered live-provider fallback with per-source 60 s cooldown and timeout-bounded `trySource`; adding a provider = one name + one chain entry.                                                                                                                                                                                                                                                                                                                                                                              |
| `src/watchdog.ts`                                                                                                                                     | Pure mid-trip re-check: matches planned legs onto index trips by stop pair + scheduled time, flags better (≥3 min) or missed connections; `lookAheadBails()` evaluates the next 4 stops as early-exit intercepts (≥90 s reaction, ≥8 min saved).                                                                                                                                                                                                                                                                           |
| `src/transferRisk.ts`                                                                                                                                 | Transfer risk tiers: `classifyTransfer()` (same-site <8 min, walk <10 min, or ≥30 min prior ride = HIGH_RISK; MEDIUM 8–12 min; stale feed elevates <9 min buffers) + `transferTiers(chain)` profiles.                                                                                                                                                                                                                                                                                                                      |
| `src/boarding.ts`, `useTripTracking.ts`, `TripTracker.tsx`                                                                                            | Opt-in `watchPosition` boarding detector + `?simulate=1` lab.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/reliability.ts` + `src/reliabilityStore.ts`                                                                                                      | Observation model (`observation`, `observationId`, `mergeObservations`, weighted `statistics`), `localStorage` persistence (10k cap), GPS-vs-feed weighting, simulated-data quarantine.                                                                                                                                                                                                                                                                                                                                    |
| `src/semantic.ts`                                                                                                                                     | Client side of `POST /llm` tasks `parse` + `rank`: `shouldParse` gate (aiMode ≠ none, ≥2 words, no `+`, no whole-phrase category match), strict `validateParse`, one retry with errors appended, then raw-term fallback. `toTerm` maps anchors+categories to `+`-joined terms; `related_terms` are searched as extra candidate terms (union, deduped). `rankPlaces` is session-cached, silent-null fallback.                                                                                                               |
| `src/assistant.ts` + `AdventureAssistant.tsx`                                                                                                         | Full-AI-mode adventure planner: `assist` schema validation (1–4 stops, pins, dwell, round-trip, depart/return-by), `clockStamp` resolves weekdays/"tomorrow" into concrete dates, `resolveEventStops` swaps `type:"event"` stops for real events (token-match + distance scoring; no match → degrades to `category` with a visible note). Chat display history is kept separate from the ≤6-turn wire history — raw model output never enters history. Shows a gap warning when the computed chain lands past `return_by`. |
| `src/events.ts`                                                                                                                                       | Relay `GET /events` client for the assistant's event stops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/gmaps.ts` + `GmapsLink.tsx`                                                                                                                      | Relay `/gmaps/text` + `/gmaps/details`; rating/price in a session `Map` only, `place_id` persisted (500 cap); optional iframe embed via `VITE_GOOGLE_EMBED_KEY`.                                                                                                                                                                                                                                                                                                                                                           |
| `src/syncClient.ts`                                                                                                                                   | Optional Cloudflare-KV mirror of bookmarks/recents/favorites. No configured URL/token → never called. Auto-configured same-origin on the gated site.                                                                                                                                                                                                                                                                                                                                                                       |
| `src/shareUtils.ts`                                                                                                                                   | Share-link encode/decode (origin, destination, time).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/networkGeo.ts`                                                                                                                                   | Ambient network layer: `public/scan/network.json` (real GTFS shapes) → GeoJSON; falls back to the scan index's stop sequences.                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/mapLayers.ts`, `MapLayer.tsx`                                                                                                                    | MapLibre painting helpers + wiring/markers: ambient network + stop dots, hover pins, busy radar ping, tap cards (route → `route_details` + live departures; elsewhere → "what's here" + nearby departures), GPS puck/accuracy/heading, follow FAB (free → center → heading), minimized riding view (`APP_LAYER_PREFIXES` allowlist).                                                                                                                                                                                       |
| `src/basemap.ts`                                                                                                                                      | MapLibre styles for CARTO Dark Matter and Esri World Imagery + label overlay; persisted choice.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/display.ts`                                                                                                                                      | Formatting helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/Panel.tsx`, `ResultsList.tsx`, `Hud.tsx`, `ReliabilityPanel.tsx`, `SettingsPanel.tsx`, `PreferencesPanel.tsx`, `RouteChips.tsx`, `RouteHunt.tsx` | UI shell: origin/departure card, unified search box, result cards + chain timeline, journey HUD, reliability + settings + walking-preference panels, route chips, and the searching indicator (SVG pulse + `.scan-ring` radar ping; reduced-motion aware).                                                                                                                                                                                                                                                                 |

## UI structure

- Desktop: side panel + full map. Mobile (≤760 px): three-state bottom sheet
  `snap-peek` (~88 px) / `snap-half` (54 vh) / `snap-full` (92 vh), drag-snapped
  from `.panel-grabber`; defaults to `peek`, auto-expands to `half` only when
  `selected`/`chain`/`error` gives it content; `documentElement.dataset.sheet`
  reflects the state so `.hud`/`.follow-fab` reposition. Saved-places board and
  Nearby Now collapse to horizontal chip strips.
- "Change start" and "Settings" `<details>` elements hide secondary controls;
  the locate button lives inside "Change start" ("Use my location" /
  "Re-locate me" by origin type).
- Settings (`SettingsPanel.tsx`) is one `utility-panel`: AI-assistance radios,
  Results filters (`verifiedOnly`; `budgetOnly` disabled when
  `!gmapsConfigured()` — relay presence proxies "Google key configured"),
  walking prefs, reliability, and credits/data sources.
- Basemap: Dark (CARTO) ⇄ Satellite (Esri + boundaries/places overlay),
  remembered locally.
- Font: "Jockey One" (Tahoma/system fallback) — single-weight display face,
  so bold text is browser-synthesized.

## Server components (not the app backend)

- `worker/transit-relay.js` — the only server-side integration point: key
  injection, keyless-feed relay, LLM fan-out, event aggregation, Google Places,
  KV sync, MOTIS passthrough. Routes and config in
  [DEPLOYMENT.md](DEPLOYMENT.md#transit-relay-workertransit-relayjs).
- `site/index.js` — the gated host for the deployed instance only: Cloudflare
  Access verification, static-asset serving, per-user `/api/state`. A
  self-hosted `dist/` needs neither.

## Testing model

Vitest unit tests mock `fetch` (`vi.spyOn`) and exercise the pure modules
plus hooks. `api.ts`'s module-level session cache persists across tests in one
file — use distinct queries/origins per test. Guard every browser API
(`localStorage`, `geolocation`, `AbortSignal`) — tests run without a DOM.
Playwright e2e (`tests/e2e/`) is mobile-viewport only. Details in
[DEVELOPMENT.md](DEVELOPMENT.md#tests).
