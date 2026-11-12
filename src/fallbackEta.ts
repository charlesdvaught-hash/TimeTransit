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
const RELAY = import.meta.env.VITE_TRANSIT_RELAY;

// The relay's own OBA-shaped backend (worker /api/arrivals): server-decoded
// OCTA trip-updates for one stop. Sparse — the feed only reports each
// vehicle's next stop — but where it hits, it's a real approaching
// vehicle's prediction, stronger than index schedule + last-known delay.
async function relayArrivals(
  stopId: string,
  signal?: AbortSignal,
): Promise<
  {
    tripId: string;
    routeId?: string;
    delaySec?: number;
    predictedTime?: number;
  }[]
> {
  const r = await fetch(
    `${RELAY || ""}/api/arrivals?stop=${encodeURIComponent(stopId)}`,
    { signal },
  );
  if (!r.ok) throw new Error(`arrivals ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.arrivals) ? j.arrivals : [];
}

// Leg -> nearest index stop -> relay arrivals, route-matched. Realtime
// answer straight from the feed; undefined when no vehicle is inbound.
async function obaDeparture(
  index: ScanIndex,
  leg: Leg,
  signal: AbortSignal | undefined,
  now: number,
): Promise<LiveDeparture | undefined> {
  const fromIdx = nearestStop(index, leg.from);
  if (fromIdx < 0) return;
  const stop = index.stops[fromIdx];
  const list = await trySource("oba", () => relayArrivals(stop.i, signal), {
    timeoutMs: 6_000,
  });
  if (!list?.length) return;
  const norm = (s?: string) =>
    (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(leg.routeShortName);
  const hit =
    list.find((a) => norm(a.routeId) === want) ??
    (list.length === 1 ? list[0] : undefined);
  if (!hit?.predictedTime || hit.predictedTime < now - 300_000) return;
  const schedMs = Date.parse(leg.scheduledStartTime || leg.startTime);
  return {
    routeName: leg.routeShortName || leg.mode,
    headsign: leg.headsign,
    stopName: stop.n,
    network: leg.agencyName || "OCTA",
    scheduledTime: new Date(schedMs).toISOString(),
    expectedTime: new Date(hit.predictedTime).toISOString(),
    delay: hit.delaySec ?? (hit.predictedTime - schedMs) / 1000,
    realtime: true,
    cancelled: false,
    source: "oba",
  };
}

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

// Provider order depends on context:
//  "planning" — own sources first (index schedule + relay arrivals), Transit
//    last as coverage backstop. Browsing boards and route cards shouldn't
//    spend Transit quota.
//  "guidance" — Transit first: crowd-sourced positions + route confirmation
//    are worth quota when minutes count (waiting at the stop, recalc before
//    arrival, transfer checks). Ours fill gaps/outages.
export type ChainMode = "planning" | "guidance";

// Nearby-departures chain. Fills the board even with Transit down or absent.
export async function departuresNearChained(
  point: { lat: number; lon: number },
  signal?: AbortSignal,
  opts: { mode?: ChainMode } = {},
): Promise<NearbyDeparture[]> {
  let ctx: { index?: ScanIndex; delays?: TripDelays } = {};
  const own = async () => {
    if (!ctx.index) ctx = await indexDelays(signal);
    return ctx.index
      ? indexDeparturesNear(ctx.index, point, ctx.delays, Date.now())
      : [];
  };
  if (opts.mode === "planning") {
    const rows = await own();
    if (rows.length) return rows;
  }
  const hit = await trySource("transit", () => departuresNear(point, signal), {
    timeoutMs: 8_000,
  });
  if (hit?.length) return hit;
  const rows = await own();
  return rows.length ? rows : (hit ?? []);
}

// Per-leg ETA chain, mode-ordered as above. Same shape as liveDepartures().
export async function liveDeparturesChained(
  legs: (Leg | undefined)[],
  signal?: AbortSignal,
  opts: { mode?: ChainMode } = {},
): Promise<(LiveDeparture | undefined)[]> {
  const out: (LiveDeparture | undefined)[] = legs.map(() => undefined);
  const defined = legs
    .map((leg, i) => ({ leg, i }))
    .filter((x): x is { leg: Leg; i: number } => !!x.leg);
  const transitPass = async () => {
    const missing = defined.filter((x) => !out[x.i]);
    if (!missing.length) return;
    const lives = await trySource(
      "transit",
      () =>
        liveDepartures(
          missing.map((x) => x.leg),
          signal,
        ),
      { timeoutMs: 12_000 },
    );
    missing.forEach((x, k) => (out[x.i] ??= lives?.[k]));
  };
  const ownPass = async () => {
    if (!defined.some((x) => !out[x.i])) return;
    const { index, delays } = await indexDelays(signal);
    if (!index) return;
    const now = Date.now();
    for (const x of defined)
      if (!out[x.i])
        out[x.i] =
          (await obaDeparture(index, x.leg, signal, now)) ??
          indexDeparture(index, x.leg, delays, now);
  };
  if (opts.mode === "planning") {
    await ownPass();
    await transitPass();
  } else {
    await transitPass();
    await ownPass();
  }
  return out;
}
