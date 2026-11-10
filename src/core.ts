export type Place = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address?: string;
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
export function fastest(
  data: { itineraries?: Itinerary[]; direct?: Itinerary[] },
  departure?: Date,
) {
  const all = [...(data.itineraries || []), ...(data.direct || [])]
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
    );
  if (!all.length) throw new Error("No route available for this destination.");
  return all.sort((a, b) => a.duration - b.duration)[0];
}
export function rank(results: Result[]) {
  return [...results].sort((a, b) => a.trip.duration - b.trip.duration);
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
export type Stop = {
  id: string;
  label: string;
  candidates: Place[];
  dwell: number;
};
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
export async function optimize(
  origin: Place,
  stops: Stop[],
  departure: Date,
  back: boolean,
  plan: (a: Place, b: Place, t: Date) => Promise<Itinerary>,
  speed = 18,
): Promise<TripChain> {
  if (
    stops.length < 2 ||
    stops.length > 4 ||
    stops.some((s) => !s.candidates.length)
  )
    throw new Error("Choose 2–4 stops with at least one candidate each.");
  const estimate = (combo: ReturnType<typeof combinations>[number]) => {
    let p = origin,
      total = 0;
    for (const v of combo) {
      total += (distance(p, v.place) / speed) * 3600 + v.stop.dwell * 60;
      p = v.place;
    }
    return total + (back ? (distance(p, origin) / speed) * 3600 : 0);
  };
  const shortlist = combinations(stops)
    .sort((a, b) => estimate(a) - estimate(b))
    .slice(0, 5);
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
