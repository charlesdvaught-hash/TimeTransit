// Pure RAPTOR-style scan over a preprocessed GTFS index (scripts/build-scan-index.mjs).
// No DOM, no network. Times are epoch ms; GTFS trip times are seconds since
// that trip's service-day local midnight and may exceed 86400.
export type ScanStop = { i: string; n: string; la: number; lo: number };
export type ScanTrip = { s: number; i?: string; t: number[] };
export type ScanPattern = {
  r: string;
  rid: string;
  dir: number;
  h: string;
  c: string;
  rt: number;
  stops: number[];
  trips: ScanTrip[];
};
export type ScanService = {
  id: string;
  d: number;
  s: string;
  e: string;
  x: [string, number][];
};
export type ScanIndex = {
  v: number;
  feed: { start: string; end: string };
  bbox: [number, number, number, number];
  stops: ScanStop[];
  services: ScanService[];
  patterns: ScanPattern[];
  walks: [number, number, number][];
};
export type ScanResult = Map<number, number>;

const DAY = 86400;

export function inCoverage(
  index: ScanIndex,
  point: { lat: number; lon: number },
) {
  const [a, b, c, d] = index.bbox;
  return point.lat >= a && point.lat <= c && point.lon >= b && point.lon <= d;
}

// local civil time for the agency timezone → {day: "YYYYMMDD", sec, midnightEpoch}
export function localDay(epochMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(epochMs);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const sec = (+p.hour % 24) * 3600 + +p.minute * 60 + +p.second;
  return {
    day: `${p.year}${p.month}${p.day}`,
    sec,
    midnightEpoch: epochMs - sec * 1000,
  };
}

// service active on local day ymd, where baseEpoch is that day's local midnight
function serviceDays(index: ScanIndex, tz: string, epochMs: number) {
  const { midnightEpoch } = localDay(epochMs, tz);
  const days: { ymd: string; base: number }[] = [];
  for (const back of [0, 1]) {
    const base = midnightEpoch - back * DAY * 1000;
    days.push({ ymd: localDay(base + 1000, tz).day, base });
  }
  return days;
}
function active(svc: ScanService, ymd: string, weekday: number) {
  let on = svc.s <= ymd && ymd <= svc.e && ((svc.d >> weekday) & 1) === 1;
  for (const [date, type] of svc.x || []) {
    if (date === ymd) on = type === 1;
  }
  return on;
}

export const haversine = (
  a: { lat: number; lon: number },
  b: { la: number; lo: number },
) => {
  const r = 6371000,
    dLa = ((b.la - a.lat) * Math.PI) / 180,
    dLo = ((b.lo - a.lon) * Math.PI) / 180,
    s =
      Math.sin(dLa / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) *
        Math.cos((b.la * Math.PI) / 180) *
        Math.sin(dLo / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(s));
};

// stop -> [patternIdx, position][] built once per index
const patsCache = new WeakMap<ScanIndex, [number, number][][]>();
export function stopPatterns(index: ScanIndex) {
  let out = patsCache.get(index);
  if (!out) {
    out = index.stops.map(() => []);
    index.patterns.forEach((p, pi) =>
      p.stops.forEach((si, pos) => out![si].push([pi, pos])),
    );
    patsCache.set(index, out);
  }
  return out;
}
// stop -> [stopIdx, meters][] from index.walks
const linksCache = new WeakMap<ScanIndex, [number, number][][]>();
export function walkLinks(index: ScanIndex) {
  let out = linksCache.get(index);
  if (!out) {
    out = index.stops.map(() => []);
    for (const [a, b, m] of index.walks) out[a].push([b, m]);
    linksCache.set(index, out);
  }
  return out;
}
// pattern -> catchable trips {base epoch, t} for the service days around `key`
const activeCache = new WeakMap<
  ScanIndex,
  Map<string, { base: number; i?: string; t: number[] }[][]>
>();
export function activeTripsFor(
  index: ScanIndex,
  tz: string,
  departEpochMs: number,
) {
  const { midnightEpoch } = localDay(departEpochMs, tz);
  const key = `${tz}|${midnightEpoch}`;
  let perDay = activeCache.get(index);
  if (!perDay) activeCache.set(index, (perDay = new Map()));
  let cached = perDay.get(key);
  if (!cached) {
    const dayBases = serviceDays(index, tz, departEpochMs);
    cached = index.patterns.map((p) =>
      p.trips.flatMap((trip) =>
        dayBases.flatMap(({ ymd, base }) => {
          const weekday = new Date(base).getUTCDay(); // 0 Sun .. 6 Sat
          const bit = (weekday + 6) % 7; // Mon=0 .. Sun=6 matches svc.d
          return active(index.services[trip.s], ymd, bit)
            ? [{ base, i: trip.i, t: trip.t }]
            : [];
        }),
      ),
    );
    if (perDay.size > 20) perDay.clear();
    perDay.set(key, cached);
  }
  return cached;
}

export type ScanOpts = {
  tz?: string;
  walkSpeed?: number; // m/s
  maxWalkM?: number; // origin walk reach
  rounds?: number; // max boardings
  delays?: Map<string, Map<string, { d?: number; t?: number }>>; // trip_id -> stop_id -> {delay s | abs time s}
};
export function scan(
  index: ScanIndex,
  from: { lat: number; lon: number },
  departEpochMs: number,
  opts: ScanOpts = {},
): ScanResult {
  const tz = opts.tz || "America/Los_Angeles";
  const speed = opts.walkSpeed || 1.33;
  const maxWalk = opts.maxWalkM || 800;
  const maxRounds = opts.rounds ?? 4;
  const links = walkLinks(index);
  const activeTrips = activeTripsFor(index, tz, departEpochMs);

  const best: ScanResult = new Map();
  let marked = new Set<number>();
  for (let i = 0; i < index.stops.length; i++) {
    const m = haversine(from, index.stops[i]);
    if (m <= maxWalk) {
      const at = departEpochMs + (m / speed) * 1000;
      best.set(i, at);
      marked.add(i);
    }
  }

  for (let round = 0; round < maxRounds && marked.size; round++) {
    const improved = new Set<number>();
    const delayOf = (
      trip: { base: number; i?: string; t: number[] },
      si: number,
      pos: number,
    ) => {
      const u = trip.i && opts.delays?.get(trip.i)?.get(index.stops[si].i);
      if (!u) return 0;
      if (u.d !== undefined) return u.d;
      if (u.t !== undefined) return u.t - (trip.base / 1000 + trip.t[pos]);
      return 0;
    };
    for (const [pi, trips] of activeTrips.entries()) {
      const p = index.patterns[pi];
      let on: { base: number; i?: string; t: number[] } | undefined;
      for (let pos = 0; pos < p.stops.length; pos++) {
        const si = p.stops[pos];
        const arrive = best.get(si);
        // get off: this trip arrives here earlier than anything known
        if (on) {
          const at = on.base + (on.t[pos] + delayOf(on, si, pos)) * 1000;
          if (arrive === undefined || at < arrive) {
            best.set(si, at);
            improved.add(si);
          }
        }
        // (re)board an earlier catchable trip at a marked stop
        if (marked.has(si)) {
          const here = best.get(si)!;
          for (const trip of trips) {
            const dep =
              trip.base + (trip.t[pos] + delayOf(trip, si, pos)) * 1000;
            if (
              dep >= here &&
              (!on || dep < on.base + (on.t[pos] + delayOf(on, si, pos)) * 1000)
            )
              on = trip;
          }
        }
      }
    }
    // transfers: walk to linked stops
    marked = new Set();
    for (const si of improved) {
      marked.add(si);
      for (const [ni, m] of links[si]) {
        const at = best.get(si)! + (m / speed) * 1000;
        const have = best.get(ni);
        if (have === undefined || at < have) {
          best.set(ni, at);
          marked.add(ni);
        }
      }
    }
  }
  return best;
}

// earliest arrival at an arbitrary point: best stop arrival + straight-line walk-off
export function arrivalAtPoint(
  index: ScanIndex,
  result: ScanResult,
  dest: { lat: number; lon: number },
  walkSpeed = 1.33,
  maxWalkM = 800,
) {
  let best: number | undefined;
  for (const [si, at] of result) {
    const s = index.stops[si];
    if (Math.abs(s.la - dest.lat) > 0.01) continue;
    const m = haversine(dest, s);
    if (m > maxWalkM) continue;
    const at2 = at + (m / walkSpeed) * 1000;
    if (best === undefined || at2 < best) best = at2;
  }
  return best;
}
