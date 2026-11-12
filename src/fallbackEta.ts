// Keyless fallbacks derived from the local scan index + OCTA GTFS-RT. When a
// live provider (Transit today; a hosted or self-hosted OBA later) is down,
// keyless, quota-out, or doesn't cover a leg, the index still answers
// "schedule + feed delay" — the watchdog's own trip-matching math repackaged
// into the Transit client's shapes so the UI can't tell the difference.
import type { Leg } from "./core";
import { fetchTripDelays, type TripDelays } from "./gtfsrt";
import { trySource, type LiveSource } from "./liveSource";
import {
  activeTripsFor,
  haversine,
  stopPatterns,
  type ScanIndex,
} from "./scan";
import { loadScanIndex } from "./scanData";
import {
  departuresNear,
  liveDepartures,
  type LiveDeparture,
  type NearbyDeparture,
} from "./transit";
import { delayMsAt, matchTrip, near as nearestStop } from "./watchdog";

const TZ = "America/Los_Angeles";

async function indexDelays(signal?: AbortSignal) {
  const index = await loadScanIndex().catch(() => undefined);
  if (!index) return {};
  const delays = await trySource("octa-rt", () => fetchTripDelays(signal), {
    timeoutMs: 6_000,
  });
  return { index, delays };
}

// Leg -> index trip (same stop-pair + schedule match the watchdog uses) ->
// scheduled departure + GTFS-RT delay. OCTA coverage only.
export function indexDeparture(
  index: ScanIndex,
  leg: Leg,
  delays: TripDelays | undefined,
  now: number,
): LiveDeparture | undefined {
  const fromIdx = nearestStop(index, leg.from);
  const toIdx = nearestStop(index, leg.to);
  if (fromIdx < 0 || toIdx < 0) return;
  const m = matchTrip(
    index,
    activeTripsFor(index, TZ, now),
    fromIdx,
    toIdx,
    Date.parse(leg.scheduledStartTime || leg.startTime),
  );
  if (!m) return;
  const stop = index.stops[fromIdx];
  const schedMs = m.trip.base + m.trip.t[m.pos] * 1000;
  const upd = m.trip.i ? delays?.get(m.trip.i) : undefined;
  const delay = delayMsAt(upd, stop.i, schedMs);
  const source: LiveSource = "index";
  return {
    routeName: leg.routeShortName || leg.mode,
    headsign: leg.headsign,
    stopName: stop.n,
    network: leg.agencyName || "OCTA",
    scheduledTime: new Date(schedMs).toISOString(),
    expectedTime: new Date(schedMs + delay).toISOString(),
    delay: delay / 1000,
    realtime: !!upd?.get(stop.i),
    cancelled: false,
    source,
  };
}

// Next departures at the closest stops, from the index: per pattern serving
// each stop, the earliest trip not already gone — schedule + feed delay.
export function indexDeparturesNear(
  index: ScanIndex,
  point: { lat: number; lon: number },
  delays: TripDelays | undefined,
  now: number,
): NearbyDeparture[] {
  const closest = index.stops
    .map((s, i) => ({ i, m: haversine(point, s) }))
    .filter((x) => x.m <= 450)
    .sort((a, b) => a.m - b.m)
    .slice(0, 4);
  if (!closest.length) return [];
  const pats = stopPatterns(index);
  const active = activeTripsFor(index, TZ, now);
  const byKey = new Map<string, NearbyDeparture>();
  for (const { i: si } of closest) {
    for (const [pi, pos] of pats[si]) {
      let best: { dep: number; i?: string } | undefined;
      for (const trip of active[pi]) {
        const dep = trip.base + trip.t[pos] * 1000;
        if (dep > now - 60_000 && (!best || dep < best.dep))
          best = { dep, i: trip.i };
      }
      if (!best) continue;
      const p = index.patterns[pi];
      const upd = best.i ? delays?.get(best.i) : undefined;
      const row: NearbyDeparture = {
        route: p.r,
        stopName: index.stops[si].n,
        time: best.dep + delayMsAt(upd, index.stops[si].i, best.dep),
        realtime: !!upd?.get(index.stops[si].i),
      };
      const key = `${si}|${p.rid}|${p.dir}`;
      const have = byKey.get(key);
      if (!have || row.time < have.time) byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => a.time - b.time).slice(0, 6);
}

// Nearby-departures chain: Transit (predicted, multi-agency) -> index
// schedule + feed delay. Fills the board even with Transit down or absent.
export async function departuresNearChained(
  point: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<NearbyDeparture[]> {
  const hit = await trySource("transit", () => departuresNear(point, signal), {
    timeoutMs: 8_000,
  });
  if (hit?.length) return hit;
  const { index, delays } = await indexDelays(signal);
  if (!index) return hit ?? [];
  return indexDeparturesNear(index, point, delays, Date.now());
}

// Per-leg ETA chain: Transit first; legs it can't answer fall back to index
// schedule + feed delay (OCTA coverage). Same shape as liveDepartures().
export async function liveDeparturesChained(
  legs: (Leg | undefined)[],
  signal?: AbortSignal,
): Promise<(LiveDeparture | undefined)[]> {
  const out: (LiveDeparture | undefined)[] = legs.map(() => undefined);
  const defined = legs
    .map((leg, i) => ({ leg, i }))
    .filter((x): x is { leg: Leg; i: number } => !!x.leg);
  const lives = await trySource(
    "transit",
    () =>
      liveDepartures(
        defined.map((x) => x.leg),
        signal,
      ),
    { timeoutMs: 12_000 },
  );
  defined.forEach((x, k) => (out[x.i] = lives?.[k]));
  if (!defined.some((x) => !out[x.i])) return out;
  const { index, delays } = await indexDelays(signal);
  if (!index) return out;
  const now = Date.now();
  for (const x of defined)
    out[x.i] = out[x.i] ?? indexDeparture(index, x.leg, delays, now);
  return out;
}
