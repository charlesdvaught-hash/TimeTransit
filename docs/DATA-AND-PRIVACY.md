# Data & Privacy

What TimeTransit stores, where it goes, and what leaves the browser. The
short version: no backend, no accounts, no analytics, no raw GPS history.
Local storage is the primary data layer; an optional KV mirror syncs a small
blob across devices.

## Local storage (primary store)

All persistence is `localStorage` via `src/storage.ts` (`readStored` /
`writeStored`, which validate on read and coerce bad data to defaults).

| Key                          | Contents                                                                                                                                                 | Cap    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `timetransit.preferences`    | `walkDistance` (default 800 m, 200–2,000 m), `walkingSpeed`, `aiMode` (`"none"`/`"minimal"`/`"full"`, default `"minimal"`), `verifiedOnly`, `budgetOnly` | —      |
| `timetransit.origin`         | Last origin (default: Chicago)                                                                                                                           | 1      |
| `timetransit.basemap`        | Dark / Satellite choice                                                                                                                                  | 1      |
| `timetransit.reliability.v2` | Departure/arrival observations                                                                                                                           | 10,000 |
| `timetransit.gmaps-ids`      | Google `place_id` map (IDs only — allowed by Google terms; ratings/prices are session-memory only)                                                       | 500    |
| `tt_bookmarks_v1`            | Saved places (Home/Work/Gym/custom)                                                                                                                      | 4      |
| `tt_recent_searches_v1`      | Recent-search chips                                                                                                                                      | 8      |
| `tt_favorite_lines_v1`       | Starred transit lines                                                                                                                                    | 32     |
| `tt_last_plan_cache_v1`      | Last displayed trip, for offline restore                                                                                                                 | 1      |
| `tt_worker_sync_v1`          | Self-hosted sync config `{url, token}`                                                                                                                   | 1      |

Storage failures display a warning; in-memory use still works. The
Reliability panel has a clear-data button.

## Synchronization

Optional Cloudflare-KV mirroring of bookmarks, favorites, and recents via
`GET/PUT /api/state`:

- **Hosted site:** auto-configured same-origin — `src/syncClient.ts` pushes
  event-time via `useSyncPush`, keyed `state:{email}` per Cloudflare
  Access-verified email. No setup, no Settings entry.
- **Self-hosted:** manual — Settings → Sync takes a relay URL + Bearer token
  (`tt_worker_sync_v1`). Unconfigured → the client never calls it; the relay
  503s `/api/state` without the `TT_SYNC_TOKEN` secret (expected, not an
  error).
- **Local stays primary.** KV is a mirror, not the source of truth; the blob
  shape matches the localStorage shape (`{bookmarks, favoriteLines,
recentSearches, updatedAt}`).

## GPS

- `watchPosition` is **opt-in**: the idle watcher (`useUserPosition.ts`)
  starts only when permission is already granted or after "Use my location";
  trip tracking starts only on "Start trip · GPS".
- **No raw GPS trace is saved** — fixes feed the boarding detector and are
  discarded; derived departure/arrival _estimates_ (timestamp + delay) are
  what reach `timetransit.reliability.v2`.
- GPS-based observations are tagged and weighted differently from feed
  predictions (supersedes same trip/stop, else 3× weight) — the provenance
  survives in the stats.
- Geolocation requires a secure context (HTTPS or localhost) and foreground
  operation; denial, background suspension, and poor accuracy are all
  handled/degraded, never simulated.

## What leaves the browser

| Destination                         | What's sent                                             | What's not                                 |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| Transitous/MOTIS                    | Journey coordinates, departure/arrival time, walk prefs | —                                          |
| Photon                              | Search terms, origin/bounds                             | —                                          |
| TomTom                              | Typed query + origin bias point                         | Results never persisted                    |
| Transit API (via relay)             | Stop coordinates, departure time                        | lat/lon only per terms §8.4                |
| OCTA GTFS-RT (via relay)            | Nothing (feed poll)                                     | —                                          |
| Relay `/llm`, `/events`, `/gmaps/*` | Query text / candidates / coords as the task requires   | Raw model output never enters chat history |
| `/api/state` (hosted)               | The sync blob, under your verified email                | —                                          |

Notably: **the GPS trace goes nowhere.** Requests carry journey coordinates
and search terms — the data providers need to answer — not your position
history.

## Caching & retention

- **In-memory session cache:** all external JSON shares a ≤3-concurrency
  queue and a 500-entry URL-keyed cache — cleared on reload. One departure
  snapshot per new search.
- **Service worker** (`vite-plugin-pwa` runtime rules): app shell precached;
  basemap tiles + fonts CacheFirst (7 d / 30 d); `octa.json` +
  `oc.json` + `network.json` StaleWhileRevalidate (7 d); Photon + Transitous
  NetworkFirst with 8 s timeout and 24 h fallback. **Transit API responses are
  deliberately uncached** (terms §8.2: no archiving API Data beyond technical
  cache).
- **Retention:** everything above is browser-local; nothing expires
  server-side because nothing lives server-side except the per-user KV blob
  (overwritten per push). Reliability observations are deduplicated by
  trip/stop/source and capped at 10k — oldest retained data is your own
  riding history in your own browser.
- **Simulated data:** `?simulate=1` observations are tagged and quarantined
  from real stats; "Show simulated data only" inspects them.

## Third-party data handling

- TomTom results: session-cached, labeled "Places © TomTom", never persisted.
- Google rating/price: session `Map` only (Google terms); `place_id` persists;
  Google fields carry a visible "Google" label and never render on the map
  canvas.
- Transit API: badge attribution wherever API data is shown (terms §3.2); no
  personal data beyond query-required lat/lon (§8.4).
- OSM/CARTO/Esri attributions remain visible on the map.

## Accounts

None for local use. The hosted gate (Cloudflare Access email OTP) is
authentication only — it keys your sync blob; it is not a TimeTransit account
and stores no profile beyond the email-keyed KV row.
