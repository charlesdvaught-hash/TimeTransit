# TimeTransit

**Find out what's within reach. Not by distance, but by how long it actually takes to get there.**

TimeTransit is a map-first transit explorer that helps you find places based on real door-to-door travel time. Search for coffee, groceries, restaurants, businesses, or a specific destination and see what's genuinely convenient to reach by public transit and walking.

A place five miles away might be easier to reach than one two miles away. TimeTransit helps you find out.

**[Try TimeTransit](https://timetransit-site.charlesdvaught-34c.workers.dev) · [Explore the source code](https://github.com/charlesdvaught-hash/TimeTransit)**

> The hosted app is currently access-controlled. See [Using the hosted app](#using-the-hosted-app) below.

<!-- Add a large application screenshot or short GIF here. Ideally show the map, destination suggestions, and several competing journey times. -->

## What makes it different?

Most map applications start with distance or a destination you've already chosen. TimeTransit starts with a different question:

**Where can I actually get to, and how long will it take?**

Search for a type of place or a specific business. TimeTransit finds candidates, checks how they're connected to the transit network, and ranks the results by actual journey time.

Walking isn't treated as an afterthought. Walking-only alternatives compete with transit journeys, and the displayed times account for walking, waiting, transfers, and riding.

### Explore

- **Search by intent.** Look for categories like coffee, groceries, pharmacies, or restaurants, or search for a specific business.
- **Discover places by travel time.** Compare real transit and walking journeys instead of relying on straight-line distance.
- **See your alternatives.** Explore different routes and available connections on the map.
- **Choose when to travel.** Leave now, depart at a specific time, or plan around an arrival deadline.
- **Find places across providers.** OpenStreetMap, Photon, TomTom, and a local business index help uncover places that individual providers might miss.

### Plan your day

- **Multi-stop trips.** Combine two to four destinations into one outing. TimeTransit searches for convenient stop combinations and can optimize the order of your errands.
- **Saved places.** Keep Home, Work, Gym, and other destinations handy.
- **Departures board.** See upcoming departures and estimated travel times to saved destinations.
- **Nearby Now.** Find upcoming departures around your current starting point.
- **Shareable trips.** Send a journey link that restores its origin, destination, and departure time.

### Stay on top of your journey

- **Live departure estimates.** Optional Transit API integration supplements scheduled times with live estimates.
- **Route reliability.** Build local statistics from observed departures and compare early, on-time, and late performance.
- **GPS trip tracking.** Optionally monitor boarding and arrival, with a simulation lab for testing the detection system.
- **Transfer warnings.** Identify connections with limited transfer time and receive alerts when a better route becomes available.
- **Offline recovery.** Restore cached journeys when connectivity drops. Live journey planning still requires a network connection.

## Using the hosted app

The hosted application is a separate, deployed instance of TimeTransit. It runs on Cloudflare Workers and has its own provider integrations, configuration, and access controls.

**You do not need to clone the repository or configure API keys to use this version.**

1. Open the [TimeTransit hosted application](https://timetransit-site.charlesdvaught-34c.workers.dev).
2. Enter an email address that has been approved for access.
3. Retrieve the one-time verification code sent to your email.
4. Start exploring.

Cloudflare Access maintains a 30-day session, so you won't need to repeat the process every time you visit.

There is no separate TimeTransit account to create. Bookmarks, favorites, and recent searches sync between devices using your verified email.

Access is currently restricted to approved email addresses. Contact the repository maintainer to request access.

### API integrations

The hosted application is configured independently of the source repository. Its deployment operator manages provider credentials, API relays, and optional integrations.

Depending on which services are enabled, the hosted app can provide:

- Worldwide public-transit routing through Transitous/MOTIS.
- Live departure estimates through the Transit API.
- Additional business suggestions through TomTom.
- AI-assisted searches and multi-stop planning.
- Google Places enrichment.
- Local Orange County transit data, including OCTA service information.

Visitors do not need to supply their own API credentials. Optional features depend on the integrations enabled for the deployed instance.

## Running from source

The repository contains the application source code, build scripts, and supporting Cloudflare Worker code.

Cloning it gives you the project, not access to the hosted deployment or its private configuration. Cloudflare Access permissions, Worker secrets, KV storage, and provider credentials must be configured independently when setting up your own deployment.

The good news is that the core application works without paid API keys. Basic place discovery and transit planning use public services.

### Requirements

- Node.js 22.12 or newer
- npm
- Internet connection for map tiles, place searches, and journey planning

### Install and run

```bash
npm install
npm run dev -- --port 5173
```

Open `http://localhost:5173`.

### Build and test

```bash
npm run build
npx vitest run
```

Optional live API tests:

```bash
LIVE=1 npx vitest run src/live.test.ts
```

**Windows note:** In this environment, use `npm.cmd` and `npx.cmd` instead of the Git Bash npm shim.

## API configuration

Most of TimeTransit's core functionality is key-free. Additional integrations can be enabled independently.

| Integration            | Purpose                                             | Credentials                |
| ---------------------- | --------------------------------------------------- | -------------------------- |
| Transitous / MOTIS     | Transit routing and reachable-stop searches         | None                       |
| Photon / OpenStreetMap | Geocoding and place discovery                       | None                       |
| OCTA GTFS / GTFS-RT    | Local reachability and realtime transit information | None                       |
| LA Metro API           | Live bus and rail vehicle positions                 | None                       |
| TomTom Search          | Additional business and address suggestions         | Optional API key           |
| Transit API            | Live departure estimates                            | Optional API key and relay |
| Groq / Gemini          | AI-assisted search and trip planning                | Relay-side configuration   |
| Google Places          | Optional ratings, hours, and place details          | Relay-side configuration   |
| SeatGeek               | Optional event discovery                            | Optional client ID         |

### Local environment variables

Create `.env.local` in the repository root. It is gitignored and should never be committed.

**TomTom Search**

```env
VITE_TOMTOM_API_KEY=your_key
```

The TomTom key is included in the browser bundle. Restrict it to your application origins and the Search API.

**Transit API (development)**

```env
VITE_TRANSIT_API_KEY=your_key
```

The Vite development server proxies requests and adds the key server-side rather than exposing it in the browser bundle.

**Transit API (production)**

Production PWA builds cannot use the Vite development proxy. Configure a deployed relay instead:

```env
VITE_TRANSIT_RELAY=https://your-transit-relay.workers.dev
```

The relay stores the actual `TRANSIT_API_KEY` as a Cloudflare Worker secret. Configure `ALLOWED_ORIGINS` to include the application origin and any local development origin that needs access.

Without these optional integrations, TimeTransit falls back to its underlying public services wherever possible.

## Installing as an app

TimeTransit is a Progressive Web App (PWA).

Build the project:

```bash
npm run build
```

This produces an installable application in `dist/`, including its manifest, icons, and service worker.

Deploy `dist/` to an HTTPS host. On Android, open the site in Chrome and choose **Add to Home Screen** or **Install app**.

The service worker precaches the application shell and retains map tiles and fonts. Transit and search data use network-first caching with a 24-hour fallback. Cached content helps the app recover offline, but new journeys require connectivity.

## Deployment

The repository includes two Cloudflare Worker components:

**Transit relay — `worker/transit-relay.js`**

Provides the server-side integrations used by the application, including Transit API key injection, OCTA GTFS-Realtime feeds, AI requests, event discovery, Google Places enrichment, journey planning, and optional KV-backed synchronization.

A relay can be deployed independently on Cloudflare Workers.

**Hosted application — `site/index.js`**

Serves the built application and handles the gated hosted experience. Cloudflare Access provides email-based verification, while the site Worker handles per-user state synchronization.

The hosted deployment uses Cloudflare KV for cross-device user data.

The source code and production configuration are separate. Building the frontend does not automatically deploy or configure either Worker.

## Privacy and data

TimeTransit is designed to avoid collecting more information than it needs.

- Walking preferences, the last origin, and reliability observations are stored locally in the browser.
- Saved bookmarks, favorites, and recents can synchronize through the hosted application's per-user KV storage.
- Journey coordinates and search terms are sent to the public providers needed to retrieve routes and places.
- GPS tracking is opt-in. Raw GPS traces are not saved.
- GPS-based observations and feed-based estimates are distinguished in reliability calculations.
- Search results and provider responses are cached in memory for the current session.

The app does not require an account for local use. Hosted synchronization uses the email verified through Cloudflare Access.

## Under the hood

TimeTransit combines public transit routing, local search indexes, and its own journey-planning logic.

**Transit routing:** Transitous/MOTIS supplies journey plans and reachable-stop queries. Walking, waiting, transfers, and riding are included in door-to-door journey calculations.

**Local transit intelligence:** An OCTA GTFS index is preprocessed at build time into a compact reachability dataset. A RAPTOR-style scan estimates which destinations can be reached efficiently before more expensive journey planning is performed.

**Place discovery:** Photon, OpenStreetMap, TomTom, and a local Overture Maps business index contribute candidates. Results are merged, deduplicated, and ranked before detailed journey planning.

**Multi-stop optimization:** A bounded search combines candidate destinations, stay durations, and transit reachability to construct complete errands. Final displayed journeys are checked against actual chained MOTIS plans.

**Realtime reliability:** Transit observations are deduplicated by trip, stop, and source. GPS observations and feed predictions receive different weights, allowing local reliability estimates to develop over repeated journeys.

This is a heuristic optimization system, not a guarantee of a mathematically global optimum. Transit coverage, realtime predictions, and business data depend on the underlying providers.

## Project structure

| Location                  | Responsibility                                           |
| ------------------------- | -------------------------------------------------------- |
| `src/api.ts`              | Transit routing and geocoding                            |
| `src/core.ts`             | Shared ranking, geometry, search, and optimization logic |
| `src/scan.ts`             | Local transit reachability scanning                      |
| `src/places.ts`           | Local business index                                     |
| `src/transit.ts`          | Live departure estimates                                 |
| `src/metro.ts`            | LA Metro live vehicle positions (WebSocket)              |
| `src/boarding.ts`         | GPS boarding detection                                   |
| `src/reliability*.ts`     | Local transit reliability statistics                     |
| `src/watchdog.ts`         | Mid-journey route monitoring                             |
| `src/useTimeTransit.ts`   | Main application state and journey controller            |
| `worker/transit-relay.js` | External API relay and server-side integrations          |
| `site/index.js`           | Hosted application and user synchronization              |
| `scripts/`                | Build-time data preprocessing                            |

## Developer documentation

Detailed technical documentation lives in [`docs/`](docs/):

| Document                                               | Contents                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)         | Application architecture, data flow, modules, state management                                  |
| [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md)             | Reachability scanning, ranking, transfer risk, reliability, multi-stop optimizer, GPS detection |
| [`docs/API-INTEGRATIONS.md`](docs/API-INTEGRATIONS.md) | Every provider, credentials, quotas, relays, failure handling                                   |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)             | Hosted versus self-hosted deployments, Cloudflare, Access, KV, Worker configuration             |
| [`docs/DATA-AND-PRIVACY.md`](docs/DATA-AND-PRIVACY.md) | Local storage, synchronization, GPS, external requests, retention                               |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)           | Build process, tests, live tests, data preprocessing, troubleshooting                           |

Contributor-facing conventions and verified operational facts live in [`AGENTS.md`](AGENTS.md).

## Current limitations

- Public transit coverage depends on the feeds available for a particular region and time.
- Live departures are available only when the relevant integration and data source are configured.
- OpenStreetMap and external place providers do not guarantee complete business coverage.
- Local reliability statistics require sufficient observations and can be biased by the routes and trips recorded.
- GPS tracking can be affected by browser permissions, background suspension, tunnels, and poor location accuracy.
- Multi-stop planning uses bounded heuristics rather than exhaustive optimization.
- Live map access and new journey searches require an internet connection.

TimeTransit is an actively developed project. Some integrations and features are optional and may differ between local installations and hosted deployments.
