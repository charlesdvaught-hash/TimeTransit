import { arrivalAtPoint, scan, type ScanIndex } from "./scan";
export type Place = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address?: string;
  kind?: string; // venue type, e.g. "amusement arcade" — powers category-aware ranking
  stopId?: string;
  tz?: string;
};
export type Leg = {
  mode: string;
  duration: number;
  routeShortName?: string;
  routeColor?: string;
  agencyName?: string;
  agencyId?: string;
  routeId?: string;
  tripId?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  realTime?: boolean;
  distance?: number;
  headsign?: string;
  startTime: string;
  endTime: string;
  from: Place;
  to: Place;
  legGeometry?: { points: string; precision: number };
};
export type Itinerary = {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: Leg[];
};
export type Result = {
  place: Place;
  trip: Itinerary;
  alternatives?: Itinerary[];
  distance: number;
  distanceRank: number;
};
export const chicago: Place = {
  id: "origin",
  name: "Chicago · The Loop",
  lat: 41.8839,
  lon: -87.6324,
};
export const categories: Record<string, string> = {
  Coffee: "amenity:cafe",
  Grocery: "shop:supermarket",
  Pharmacy: "amenity:pharmacy",
  Restaurants: "amenity:restaurant",
  Parks: "leisure:park",
  Library: "amenity:library",
  "Hospital/Clinic": "amenity:hospital",
  Gym: "leisure:fitness_centre",
  "Bank/ATM": "amenity:bank",
  Hardware: "shop:doityourself",
};
const synonyms: Record<string, string | string[]> = {
  coffee: "amenity:cafe",
  cafe: "amenity:cafe",
  espresso: "amenity:cafe",
  grocery: ["shop:supermarket", "shop:convenience"],
  groceries: ["shop:supermarket", "shop:convenience"],
  supermarket: ["shop:supermarket", "shop:convenience"],
  market: ["shop:supermarket", "shop:convenience"],
  pharmacy: "amenity:pharmacy",
  drugstore: "amenity:pharmacy",
  chemist: "amenity:pharmacy",
  restaurant: "amenity:restaurant",
  restaurants: "amenity:restaurant",
  dining: "amenity:restaurant",
  park: "leisure:park",
  parks: "leisure:park",
  playground: "leisure:park",
  library: "amenity:library",
  libraries: "amenity:library",
  hospital: "amenity:hospital",
  emergency: "amenity:hospital",
  er: "amenity:hospital",
  clinic: "amenity:clinic",
  urgent: "amenity:clinic",
  care: "amenity:clinic",
  doctor: "amenity:doctors",
  doctors: "amenity:doctors",
  gym: "leisure:fitness_centre",
  fitness: "leisure:fitness_centre",
  workout: "leisure:fitness_centre",
  bank: "amenity:bank",
  banks: "amenity:bank",
  atm: "amenity:atm",
  hardware: "shop:doityourself",
  tools: "shop:doityourself",
};
const searchStopwords = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "in",
  "near",
  "me",
  "nearby",
  "around",
  "local",
  "find",
  "closest",
  "nearest",
  "best",
  "store",
  "stores",
  "shop",
  "shops",
  "place",
  "places",
]);
export function editDistance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++)
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = curr;
  }
  return prev[b.length];
}
function synonymTags(word: string): string[] {
  const exact = synonyms[word];
  if (exact) return Array.isArray(exact) ? exact : [exact];
  const tolerance = word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0;
  if (!tolerance) return [];
  let best: string[] = [],
    dist = Infinity;
  for (const key of Object.keys(synonyms)) {
    if (Math.abs(key.length - word.length) > tolerance) continue;
    const d = editDistance(word, key);
    if (d <= tolerance && d < dist) {
      dist = d;
      const tags = synonyms[key];
      best = Array.isArray(tags) ? tags : [tags];
    }
  }
  return best;
}
export function matchCategory(query: string): string[] {
  if (categories[query]) return [categories[query]];
  const content = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !searchStopwords.has(w));
  if (!content.length) return [];
  const tags = new Set<string>();
  for (const word of content) {
    const hit = synonymTags(word);
    if (!hit.length) return [];
    hit.forEach((t) => tags.add(t));
    if (tags.size > 2) return [];
  }
  return [...tags];
}
export function suggestCategories(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tags = new Set<string>();
  for (const [word, tag] of Object.entries(synonyms))
    if (word.startsWith(q) || q.startsWith(word))
      (Array.isArray(tag) ? tag : [tag]).forEach((t) => tags.add(t));
  return Object.keys(categories).filter((label) => {
    const name = label.toLowerCase();
    return (
      name.includes(q) ||
      tags.has(categories[label]) ||
      [...tags].some((t) => name.includes(t.split(":")[1]?.replace(/_/g, " ")))
    );
  });
}
export function distance(
  a: Pick<Place, "lat" | "lon">,
  b: Pick<Place, "lat" | "lon">,
) {
  const r = Math.PI / 180,
    dlat = (b.lat - a.lat) * r,
    dlon = (b.lon - a.lon) * r;
  return (
    6371 *
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin(dlat / 2) ** 2 +
          Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlon / 2) ** 2,
      ),
    )
  );
}
export function itineraries(
  data: { itineraries?: Itinerary[]; direct?: Itinerary[] },
  departure?: Date,
) {
  return [...(data.itineraries || []), ...(data.direct || [])]
    .filter((x) => Number.isFinite(x.duration))
    .map((x) =>
      departure
        ? {
            ...x,
            duration: Math.max(
              x.duration,
              (new Date(x.endTime).getTime() - departure.getTime()) / 1000,
            ),
          }
        : x,
    )
    .sort((a, b) => a.duration - b.duration);
}
export function fastest(
  data: { itineraries?: Itinerary[]; direct?: Itinerary[] },
  departure?: Date,
) {
  const all = itineraries(data, departure);
  if (!all.length) throw new Error("No route available for this destination.");
  return all[0];
}
export function rank(results: Result[]) {
  return [...results].sort((a, b) => a.trip.duration - b.trip.duration);
}
export type ReachableStop = { lat: number; lon: number; minutes: number };
export function rankByReachability(
  origin: Place,
  places: Place[],
  stops: ReachableStop[],
  walkingSpeed: number,
) {
  const estimate = (p: Place) => {
    let best = Infinity;
    for (const s of stops) {
      const km = distance(p, s);
      if (km <= 1.5)
        best = Math.min(best, s.minutes + (km * 1000) / walkingSpeed / 60);
    }
    return Number.isFinite(best)
      ? best
      : (distance(origin, p) * 1000) / walkingSpeed / 60;
  };
  const scores = new Map(places.map((p) => [p.id, estimate(p)]));
  return [...places].sort(
    (a, b) =>
      scores.get(a.id)! - scores.get(b.id)! ||
      distance(origin, a) - distance(origin, b),
  );
}
export function decode(points: string, precision = 5): [number, number][] {
  let i = 0,
    lat = 0,
    lon = 0;
  const out: [number, number][] = [];
  const read = () => {
    let v = 0,
      s = 0,
      b;
    do {
      b = points.charCodeAt(i++) - 63;
      v |= (b & 31) << s;
      s += 5;
    } while (b >= 32 && i < points.length);
    return v & 1 ? ~(v >> 1) : v >> 1;
  };
  while (i < points.length) {
    lat += read();
    lon += read();
    out.push([lon / 10 ** precision, lat / 10 ** precision]);
  }
  return out;
}
export type Pin = "first" | "middle" | "last";
export type Stop = {
  id: string;
  label: string;
  candidates: Place[];
  dwell: number;
  pin?: Pin;
};
export function pinError(stops: { pin?: Pin }[]) {
  const n = stops.length;
  if (stops.filter((s) => s.pin === "first").length > 1)
    return "Only one stop can be pinned first.";
  if (stops.filter((s) => s.pin === "last").length > 1)
    return "Only one stop can be pinned last.";
  if (stops.every((s) => s.pin === "middle"))
    return "Middle pins need at least one unpinned stop to lead or end the trip.";
  if (stops.some((s) => s.pin === "middle") && n < 3)
    return "A middle stop needs at least 3 destinations.";
}
// position (0..n-1) a pinned stop may occupy in an ordering of n stops
export function pinAllows(pin: Pin | undefined, pos: number, n: number) {
  if (pin === "first") return pos === 0;
  if (pin === "last") return pos === n - 1;
  if (pin === "middle") return pos > 0 && pos < n - 1;
  return true;
}
export function pinsHold(combo: { stop: Stop }[], n: number) {
  return combo.every((v, i) => pinAllows(v.stop.pin, i, n));
}
export type TripChain = {
  visits: { stop: Stop; place: Place; trip: Itinerary }[];
  returnTrip?: Itinerary;
  duration: number;
};
export function combinations(
  stops: Stop[],
  used: ReadonlySet<string> = new Set(),
): { stop: Stop; place: Place }[][] {
  if (!stops.length) return [[]];
  return stops.flatMap((stop, i) =>
    stop.candidates
      .filter(
        (place, index, candidates) =>
          !used.has(place.id) &&
          candidates.findIndex((candidate) => candidate.id === place.id) ===
            index &&
          !stops.some(
            (other) =>
              other.id !== stop.id &&
              other.candidates.length === 1 &&
              other.candidates[0].id === place.id,
          ),
      )
      .slice(0, 3)
      .flatMap((place) =>
        combinations(
          stops.filter((_, j) => i !== j),
          new Set([...used, place.id]),
        ).map((rest) => [{ stop, place }, ...rest]),
      ),
  );
}
// Beam search: rank stop orders by real route-pattern arrival times from the
// scan. One scan per open state reaches every remaining candidate at once.
export function scanOrder(
  index: ScanIndex,
  origin: Place,
  stops: Stop[],
  departMs: number,
  opts: {
    back?: boolean;
    walkSpeed?: number;
    maxWalkM?: number;
    beam?: number;
    tz?: string;
    delays?: Map<string, Map<string, { d?: number; t?: number }>>;
  } = {},
): { combo: { stop: Stop; place: Place }[]; total: number }[] {
  const n = stops.length;
  type St = {
    at: number;
    combo: { stop: Stop; place: Place }[];
    left: Stop[];
    used: Set<string>;
    from: { lat: number; lon: number };
  };
  const scanOpts = {
    walkSpeed: opts.walkSpeed,
    maxWalkM: opts.maxWalkM,
    tz: opts.tz,
    delays: opts.delays,
  };
  const expand = (st: St, level: number) => {
    const r = scan(index, st.from, st.at, scanOpts);
    const out: St[] = [];
    for (const s of st.left) {
      if (!pinAllows(s.pin, level, n)) continue;
      for (const place of s.candidates.slice(0, 3)) {
        if (st.used.has(place.id)) continue;
        if (
          st.left.some(
            (o) =>
              o !== s &&
              o.candidates.length === 1 &&
              o.candidates[0].id === place.id,
          )
        )
          continue;
        const at = arrivalAtPoint(
          index,
          r,
          place,
          opts.walkSpeed,
          opts.maxWalkM,
        );
        if (at === undefined) continue;
        out.push({
          at: at + s.dwell * 60000,
          combo: [...st.combo, { stop: s, place }],
          left: st.left.filter((x) => x !== s),
          used: new Set([...st.used, place.id]),
          from: place,
        });
      }
    }
    return out;
  };
  let states: St[] = [
    { at: departMs, combo: [], left: stops, used: new Set(), from: origin },
  ];
  for (let level = 0; level < n && states.length; level++) {
    states = states
      .flatMap((st) => expand(st, level))
      .sort((a, b) => a.at - b.at)
      .slice(0, opts.beam ?? 10);
  }
  const seen = new Set<string>();
  return states
    .flatMap((st) => {
      let end = st.at;
      if (opts.back) {
        const r = scan(index, st.from, st.at, scanOpts);
        end =
          arrivalAtPoint(index, r, origin, opts.walkSpeed, opts.maxWalkM) ??
          Infinity;
      }
      const key = st.combo.map((v) => `${v.stop.id}:${v.place.id}`).join("|");
      if (seen.has(key) || !Number.isFinite(end)) return [];
      seen.add(key);
      return [{ combo: st.combo, total: (end - departMs) / 1000 }];
    })
    .sort((a, b) => a.total - b.total);
}
export async function optimize(
  origin: Place,
  stops: Stop[],
  departure: Date,
  back: boolean,
  plan: (a: Place, b: Place, t: Date) => Promise<Itinerary>,
  speed = 18,
  order?: { combo: { stop: Stop; place: Place }[]; total: number }[],
): Promise<TripChain> {
  if (
    stops.length < 2 ||
    stops.length > 4 ||
    stops.some((s) => !s.candidates.length)
  )
    throw new Error("Choose 2–4 stops with at least one candidate each.");
  const pinErr = pinError(stops);
  if (pinErr) throw new Error(pinErr);
  const estimate = (combo: ReturnType<typeof combinations>[number]) => {
    let p = origin,
      total = 0;
    for (const v of combo) {
      total += (distance(p, v.place) / speed) * 3600 + v.stop.dwell * 60;
      p = v.place;
    }
    return total + (back ? (distance(p, origin) / speed) * 3600 : 0);
  };
  const pool = order?.length
    ? order.map((o) => o.combo)
    : combinations(stops)
        .filter((c) => pinsHold(c, stops.length))
        .sort((a, b) => estimate(a) - estimate(b));
  const shortlist = pool.slice(0, 5);
  if (!shortlist.length)
    throw new Error(
      "No trip with distinct places is available. Choose different stops or broaden your searches.",
    );
  let best: TripChain | undefined;
  let error: unknown;
  for (const combo of shortlist) {
    try {
      let p = origin,
        t = new Date(departure);
      const visits: TripChain["visits"] = [];
      for (const v of combo) {
        const trip = await plan(p, v.place, t);
        visits.push({ ...v, trip });
        t = new Date(new Date(trip.endTime).getTime() + v.stop.dwell * 60000);
        p = v.place;
      }
      const returnTrip = back ? await plan(p, origin, t) : undefined;
      const duration =
        ((returnTrip ? new Date(returnTrip.endTime) : t).getTime() -
          departure.getTime()) /
        1000;
      if (!best || duration < best.duration)
        best = { visits, returnTrip, duration };
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      error = e;
    }
  }
  if (!best) throw error || new Error("No complete trip could be routed.");
  return best;
}
