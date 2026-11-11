import type { Leg } from "./core";
import {
  activeTripsFor,
  arrivalAtPoint,
  haversine,
  scan,
  type ScanIndex,
} from "./scan";
import type { TripDelays, VehiclePos } from "./gtfsrt";

export type WatchdogResult =
  | { kind: "better"; eta: number; savesMin: number; hint: string }
  | { kind: "missed"; eta?: number; hint: string }
  | null;

const ll = (s: { la: number; lo: number }) => ({ lat: s.la, lon: s.lo });
const meters = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
) => haversine(a, { la: b.lat, lo: b.lon });

const near = (
  index: ScanIndex,
  p: { lat: number; lon: number },
  maxM = 250,
) => {
  let best = -1,
    bestM = maxM;
  for (let i = 0; i < index.stops.length; i++) {
    const m = haversine(p, index.stops[i]);
    if (m < bestM) {
      bestM = m;
      best = i;
    }
  }
  return best;
};

type ActiveTrip = { base: number; i?: string; t: number[] };
// index trip serving fromIdx -> ... -> toIdx departing fromIdx ~= schedMs
function matchTrip(
  index: ScanIndex,
  active: ActiveTrip[][],
  fromIdx: number,
  toIdx: number,
  schedMs: number,
) {
  let found: { trip: ActiveTrip; pi: number; pos: number } | undefined;
  for (let pi = 0; pi < active.length; pi++) {
    const stops = index.patterns[pi].stops;
    const pos = stops.indexOf(fromIdx);
    if (pos < 0 || stops.indexOf(toIdx, pos + 1) < 0) continue;
    for (const trip of active[pi]) {
      const dep = trip.base + trip.t[pos] * 1000;
      if (
        Math.abs(dep - schedMs) <= 180000 &&
        (!found ||
          Math.abs(dep - schedMs) <
            Math.abs(
              found.trip.base + found.trip.t[found.pos] * 1000 - schedMs,
            ))
      )
        found = { trip, pi, pos };
    }
  }
  return found;
}

const delayMsAt = (
  upd: Map<string, { d?: number; t?: number }> | undefined,
  stopId: string,
  schedMs: number,
) => {
  const u = upd?.get(stopId);
  if (u?.d !== undefined) return u.d * 1000;
  if (u?.t !== undefined) return u.t * 1000 - schedMs;
  return 0;
};

// where is the bus for this leg right now? leg -> index trip -> live
// position, plus how far it is and when it'll reach the target stop.
export function liveBusFor(
  index: ScanIndex,
  leg: Leg,
  vehicles: Map<string, VehiclePos>,
  delays: TripDelays | undefined,
  now: number,
  tz = "America/Los_Angeles",
): {
  lat: number;
  lon: number;
  bearing?: number;
  stopsAway?: number;
  eta?: number;
} | null {
  const fromIdx = near(index, leg.from),
    toIdx = near(index, leg.to);
  if (fromIdx < 0 || toIdx < 0) return null;
  const m = matchTrip(
    index,
    activeTripsFor(index, tz, now),
    fromIdx,
    toIdx,
    Date.parse(leg.scheduledStartTime || leg.startTime),
  );
  const v = m?.trip.i ? vehicles.get(m.trip.i) : undefined;
  if (!v || !m) return null;
  const stops = index.patterns[m.pi].stops;
  const target = stops.indexOf(toIdx, m.pos);
  // closest pattern stop to the vehicle = where it is on the route
  let at = m.pos;
  for (let i = 0; i < stops.length; i++)
    if (
      haversine(v, index.stops[stops[i]]) < haversine(v, index.stops[stops[at]])
    )
      at = i;
  const stopsAway = Math.max(0, target - at);
  // scheduled arrival at the target stop + reported delay (delayMsAt
  // returns 0 when the feed has no update — sched stands as fallback)
  const sched = m.trip.base + m.trip.t[target] * 1000;
  const eta =
    sched +
    delayMsAt(delays?.get(m.trip.i!), index.stops[stops[target]].i, sched);
  return { lat: v.lat, lon: v.lon, bearing: v.bearing, stopsAway, eta };
}

export function watchJourney(opts: {
  index: ScanIndex;
  legs: Leg[];
  transitIndex: number; // which transit leg you are on / waiting for
  phase: "approaching" | "waiting" | "boarded";
  position?: { lat: number; lon: number };
  now: number;
  delays?: TripDelays;
  walkSpeed?: number;
  tz?: string;
  minSaveMin?: number;
}): WatchdogResult {
  const { index, legs, now } = opts;
  const transit = legs.filter((l) => l.mode !== "WALK");
  const leg = transit[opts.transitIndex];
  const next = transit[opts.transitIndex + 1];
  const dest = legs[legs.length - 1].to;
  const plannedEnd = Date.parse(legs[legs.length - 1].endTime);
  if (!leg || !Number.isFinite(plannedEnd)) return null;

  const active = activeTripsFor(index, opts.tz ?? "America/Los_Angeles", now);
  const saveMs = (opts.minSaveMin ?? 3) * 60000;
  const candidates: {
    p: { lat: number; lon: number };
    at: number;
    hint: string;
  }[] = [];

  const fallbackEta = (from: { lat: number; lon: number }, at: number) => {
    const res = scan(index, from, at, {
      delays: opts.delays,
      walkSpeed: opts.walkSpeed,
      tz: opts.tz,
    });
    return arrivalAtPoint(index, res, dest, opts.walkSpeed);
  };

  if (opts.phase === "boarded") {
    const fromIdx = near(index, leg.from),
      toIdx = near(index, leg.to);
    const m =
      fromIdx >= 0 && toIdx >= 0
        ? matchTrip(
            index,
            active,
            fromIdx,
            toIdx,
            Date.parse(leg.scheduledStartTime || leg.startTime),
          )
        : undefined;
    if (m) {
      const stops = index.patterns[m.pi].stops;
      const toPos = stops.indexOf(toIdx, m.pos + 1);
      const end = toPos > 0 ? toPos : stops.length;
      const upd = m.trip.i ? opts.delays?.get(m.trip.i) : undefined;
      const arrAt = (pos: number) => {
        const sched = m.trip.base + m.trip.t[pos] * 1000;
        return sched + delayMsAt(upd, index.stops[stops[pos]].i, sched);
      };
      for (let pos = m.pos + 1, shown = 0; pos < end && shown < 8; pos++) {
        const arr = arrAt(pos);
        if (arr < now - 30000) continue;
        shown++;
        const name = index.stops[stops[pos]].n;
        candidates.push({
          p: ll(index.stops[stops[pos]]),
          at: arr,
          hint:
            stops[pos] === toIdx
              ? `stay on to ${name}`
              : `hop off at ${name} and continue from there`,
        });
      }
      // missed connection? your arrival at the alight stop vs next leg departure
      if (next && toPos > 0) {
        const nFrom = near(index, next.from),
          nTo = near(index, next.to);
        const nm =
          nFrom >= 0 && nTo >= 0
            ? matchTrip(
                index,
                active,
                nFrom,
                nTo,
                Date.parse(next.scheduledStartTime || next.startTime),
              )
            : undefined;
        if (nm) {
          const nStops = index.patterns[nm.pi].stops;
          const nUpd = nm.trip.i ? opts.delays?.get(nm.trip.i) : undefined;
          const nSched = nm.trip.base + nm.trip.t[nStops.indexOf(nFrom)] * 1000;
          const nDep = nSched + delayMsAt(nUpd, index.stops[nFrom].i, nSched);
          if (arrAt(toPos) > nDep - 45000)
            return {
              kind: "missed",
              eta: fallbackEta(ll(index.stops[toIdx]), arrAt(toPos)),
              hint: `you'll miss the ${next.routeShortName || next.mode} at ${next.from.name}`,
            };
        }
      }
    }
  } else if (opts.position) {
    candidates.push({
      p: opts.position,
      at: now,
      hint: "a different route from where you are",
    });
    // waiting-phase: can you still reach the planned boarding in time?
    const nFrom = near(index, leg.from),
      nTo = near(index, leg.to);
    const nm =
      nFrom >= 0 && nTo >= 0
        ? matchTrip(
            index,
            active,
            nFrom,
            nTo,
            Date.parse(leg.scheduledStartTime || leg.startTime),
          )
        : undefined;
    if (nm) {
      const nStops = index.patterns[nm.pi].stops;
      const nUpd = nm.trip.i ? opts.delays?.get(nm.trip.i) : undefined;
      const nSched = nm.trip.base + nm.trip.t[nStops.indexOf(nFrom)] * 1000;
      const dep = nSched + delayMsAt(nUpd, index.stops[nFrom].i, nSched);
      const arriveAt =
        now +
        (meters(opts.position, leg.from) / (opts.walkSpeed ?? 1.33)) * 1000;
      if (arriveAt > dep - 30000)
        return {
          kind: "missed",
          eta: fallbackEta(opts.position, now),
          hint: `the planned ${leg.routeShortName || leg.mode} at ${leg.from.name} is no longer catchable`,
        };
    }
  }

  let best: { eta: number; hint: string } | undefined;
  for (const c of candidates) {
    const eta = fallbackEta(c.p, c.at);
    // on ties prefer the later decision point — the hint lands where the
    // actual divergent action happens, not at a redundant earlier stop
    if (eta && (!best || eta <= best.eta)) best = { eta, hint: c.hint };
  }
  if (best && best.eta < plannedEnd - saveMs)
    return {
      kind: "better",
      eta: best.eta,
      savesMin: Math.round((plannedEnd - best.eta) / 60000),
      hint: best.hint,
    };
  return null;
}
