# Algorithms

How TimeTransit actually decides what to show. Everything here is heuristic
optimization — bounded searches and weighted estimates tuned for interactivity,
not guarantees of a global optimum. Modules are pure where possible; see
[ARCHITECTURE.md](ARCHITECTURE.md) for where each piece lives.

## Place discovery & ranking (explore)

1. **Suggestion merge.** The search box merges three sources —
   `places.ts` (local Overture index, name-and-kind scored), Photon
   (tag-filtered + name matches), TomTom (fuzzy) — via `suggestions.ts`'s
   name-relevance merge. A business starting with your words outranks a
   similarly named one; an exact name surfaces above place-type rows so Enter
   picks the business. Suggestions publish once (1.4 s cap) — no
   partial-result flicker.
2. **Fuzzy category resolution.** `matchCategory` (`core.ts`) maps free text →
   OSM tags via synonym tables + stopword stripping + edit-distance tolerance
   scaled by word length. "groery store" and "urgent care" resolve to
   `shop:supermarket` / `healthcare` tags; results merge tag-filtered hits with
   name matches so Walmart surfaces for "grocery" even though its name never
   says it.
3. **Candidate bounding.** ~20 km radius, deduplicated across providers.
   With AI on, a fourth source joins the merge in parallel — **LLM
   discovery** (`semantic.suggestPlaces` → `discovery.verifySuggestion`):
   the model proposes ≤6 specific place names it believes satisfy the
   intent (niche or out-of-area spots), and each name must geocode-verify
   through Photon — a same-named result (accent-folded token match ≥50% of
   significant tokens) within 120 km — before entering the pool.
   Unverifiable names are dropped, so hallucinations can't reach results.
4. **Reachability pre-rank.** MOTIS `one-to-all` computes reach time to a stop
   within 1.5 km of each candidate, plus a walk at the configured speed. The
   best ~20 are then planned exactly with `v2/plan`. A farther place on an
   adjoining bus route can outrank a nearer one with no service. The call is
   bounded by a 2.5 s race; unavailable → distance order, so a slow upstream
   never blocks results.
5. **Displayed times.** Each result uses the fastest Transitous itinerary
   including direct walking; times include walking, waiting, riding, and
   transfers; arrivals use the browser timezone. Transfers are planned by
   MOTIS at every served stop — including ordinary stops where routes cross at
   intersections — and the app never invents a transfer at an intersection
   with no stop.
6. **LLM rerank (optional).** With AI assistance on, `rankPlaces` reorders the
   reachability candidates by intent fit (names + kinds only, never invented
   places). Its picks get the plan calls; display order stays journey-time.

Every `/llm` call (`parse`, `rank`, `assist`, `suggest`) can carry a
one-shot `context` block — `llmContext(origin)` emits the origin name +
coordinates, current local time, and walk-distance transit corridors
(`routeCorridors`: patterns whose nearest stop is ≤1.6 km, deduped by
route+headsign, nearest first, capped at 14). Context is advisory: the
model can steer toward reachable corridors, but every suggestion still
verifies against real data afterwards.

## Local reachability scan (`scan.ts`)

A RAPTOR-style scan over a build-time index (`public/scan/octa.json`, ~3.4 MB:
5,269 stops, 146 patterns, 7,243 trips, 9,946 transfer-walk links, service
calendars). `scanData.ts` lazy-loads it; the SW caches it
StaleWhileRevalidate, not precache.

- Rounds of **board → ride → transfer-walk**, service-calendar aware,
  overnight trips handled.
- `gtfsrt.ts` overlays live delays onto matching trips departing within ~2 h.
- Uses: explore candidate ranking and multi-stop ordering **inside OCTA
  coverage**. Outside coverage, `one-to-all` / `plan()` carry the load — MOTIS
  still plans every displayed journey, everywhere.
- Validation receipt: scan-vs-MOTIS spot check (Nov 2026, Anaheim→Santa Ana)
  66 min vs 68 min — 1.4 min gap. `LIVE=1 npx vitest run src/spotcheck.test.ts`.

## Multi-stop optimizer (`+` syntax)

Two to four `+`-separated terms; any term may be a category phrase or a place
name (a pinned result stays pinned).

- **Candidate resolution** (`tripCandidates.resolveTripCandidates`): each
  stop's prospects ranked by `candidateTimer` estimated arrival — local scan
  inside coverage, `one-to-all` outside, a real `plan()` only for candidates
  estimates can't see. Keeps a best-six `pool` plus up to fourteen
  `alternates` (the swap pool); `pool` doubles as a scarcity signal.
- **Ordering** (`scanOrder`): beam search over the scan index — each state
  expands with one reachability scan, so ordering follows real bus paths and
  schedules, not straight-line guesses (haversine heuristic outside coverage).
  Drag-reorder/lock constrains the search; plain-language errors for
  conflicts (two Firsts, all-Middle with <3 stops).
- **Route cards** (`optimizeKeystones`, `core.ts`): ≤3 cards grouped around
  the **keystone** — the rarest stop (a museum among twenty lunch spots). Each
  card is a complete trip through a different keystone pick, scored by
  whole-errand convenience: total duration + per-transfer penalty − credit for
  un-picked candidates within walking distance of the route. A note shows when
  unpinning would save time.
- **Stay durations** default to 15 min per stop; each leg departs at the
  previous actual arrival + dwell, including dwell at the last stop. Optional
  round trip once ≥2 destinations.
- **Verification:** displayed routes are real chained MOTIS plans — the
  estimates pick _which_ combos to try, never what to display. Failed complete
  combinations are skipped; if none work the API error is shown. Bounded
  heuristic, not exhaustive.

## Walking budgets & flags

Preferences (persisted): 800 m per walking leg default (200–2,000 m range) +
selectable walking speed. MOTIS receives `maxPreTransitTime`,
`maxPostTransitTime`, `maxDirectTime` in seconds (distance ÷ speed) plus
`pedestrianSpeed`, `withDistance=true`, `arriveBy`.

These are street-routing **time budgets**, not distance guarantees: returned
legs exceeding the distance are visibly flagged (including transfers; duration
× speed when distance is absent). The current OpenAPI has no
max-transfer-walk-distance parameter, so transfer walks are checked locally —
flagged, never silently dropped.

## Transfer risk (`transferRisk.ts`)

`classifyTransfer()` assigns a tier per connection:

- **HIGH_RISK:** same-site buffer <8 min, or transfer walk <10 min, or the
  prior ride ran ≥30 min. A stale GTFS-RT feed (relay's `x-feed-stale` header
  → `feedStale()`) elevates <9 min buffers — no fabricated staleness-to-delay
  math.
- **MEDIUM:** 8–12 min buffer band.
- **LOW:** everything else.

`transferTiers(chain)` profiles every transfer in a trip; `useTripSearch`
tightens the live-alternative recalc gate from 60 s → 15 s near HIGH_RISK
transfers.

## Reliability model (`reliability.ts` + `reliabilityStore.ts`)

Local, accumulating statistics from observed departures — every plan response
records all realtime transit-leg departure estimates, including alternatives.

- **Identity:** agency ID + route ID. **Dedup:** `observationId` = trip ID +
  stop ID + source — repeated feed polls don't inflate sample counts.
- **Weighting:** a GPS observation supersedes a feed estimate for the same
  trip/stop; otherwise it carries 3× feed weight.
- **Windows:** >60 s early or >300 s late is outside on-time.
- **Flags:** with ≥5 distinct trip/stop samples, <70% on-time or a weighted
  median outside the window labels a route "Runs early" / "Often late".
  Statistics show distinct sample count, weighted median delay, and weighted
  early/on-time/late percentages.
- Arrivals are recorded separately and do not penalize early departures.
- Simulated observations (the `?simulate=1` lab) are tagged and excluded from
  real stats/badges — "Show simulated data only" inspects them. Demo
  identities are reused so repeated seeding doesn't multiply samples.
- These are local, potentially biased estimates — not a universal reliability
  rating. Cap: 10,000 observations; storage failures warn but in-memory use
  continues.

## GPS boarding detection (`boarding.ts` + `useTripTracking`)

Opt-in per trip ("Start trip · GPS" requests `watchPosition` on demand). For
each transit leg — including multi-stop/return legs:

- **Waiting:** detector waits near boarding: within 75 m + capped accuracy
  allowance of the stop.
- **Boarding:** requires >4 m/s measured motion sustained ≥20 s while within
  ~60 m of the route geometry. Departure timestamps at the first qualifying
  fix outside the stop area — not when confirmation finishes.
- **Arrival:** sustained slowing near the exit stop or walking off the
  polyline.
- **Rejections:** fixes with >50 m uncertainty, stale timestamps, or large
  gaps don't establish boarding. Missing route geometry or schedule disables
  tracking with a visible explanation.
- **Destination POIs:** once `isBoarded`, up to 8 food/coffee/grocery POIs
  within ~250 m of the destination stop are snapshotted via `placesNear` +
  `ridePoiKind` (word-boundary match — "marketing agency" and "barber" are
  excluded). Cards render in the panel, pins on the `route-dest-pois` layer
  (the `route-` prefix is in `APP_LAYER_PREFIXES`, so it survives the
  riding-view filter).
- **Limits:** GPS alone can't distinguish parallel routes or prove boarding —
  manual trip selection + foreground GPS required. Permission denial,
  background suspension, tunnels, and sparse fixes can all prevent detection.
  No raw GPS trace is saved.
- **Sim lab:** `/?simulate=1` replays a synthetic GPS trace through the same
  detector on any selected leg with a signed delay; "Seed 5 demo trips"
  demonstrates reliability flags (−2 min or >+5 min; +4 min is inside the
  window).

## Mid-trip watchdog (`watchdog.ts`)

While GPS tracking runs, the watchdog re-checks the plan against GTFS-RT
delays:

- Matches planned legs onto index trips by stop pair + scheduled time.
- Evaluates remaining stops on the current leg plus where you're standing as
  re-route candidates: **"Switch route"** alert on a continuation ≥3 min
  better (sound + banner + re-plan via `planOptions`), or a flag when a
  connection is no longer catchable.
- `lookAheadBails()`: scans up to 4 stops ahead for early-exit intercepts —
  ≥90 s reaction window, ≥8 min saved vs riding to the terminal, ≤200 m walk
  to board — feeding the "Exit & replan" prompt with an intercept-route label.
- Actionable bail/missed states tighten polling 30 s → 15 s.

The same poll drives the live-bus marker through a three-source chain:
`liveBusFor` matches the leg's trip inside the OCTA index (stop pair +
scheduled time → vehicle position), then `metroBusFor` opens Metro's
`vehicle_positions` WebSocket filtered to the leg's route and picks the
nearest same-route vehicle, then Transit's `/v4/vehicles` as the quota-spending
last resort. Outside OCTA index coverage the watchdog can't run, but the
marker chain still does — Metro territory gets live positions without the
scan index. Metro supplies positions only (its `trip_updates` lane is dead
upstream), so a Metro marker carries no `stopsAway`/`eta` — it's a dot, not a
prediction.

## Keyless ETA fallback (`fallbackEta.ts` + `liveSource.ts`)

When a live provider is down, keyless, quota-out, or can't see a leg, the
index still answers "schedule + last-known feed delay":

- `liveSource` maintains provider health (60 s cooldown on throw/stall) and
  runs an ordered chain — first source yielding a value wins, and answers are
  tagged by source (the seam for a future prediction-vs-actual scoreboard).
- `fallbackEta` repackages the watchdog's own trip-matching math into the
  Transit client's `LiveDeparture`/`NearbyDeparture` shapes — the UI can't
  tell a keyless estimate from a paid one. The relay's `/api/arrivals`
  (edge-decoded OCTA trip updates, sparse but real predictions) outranks
  index schedule + delay where it hits.
