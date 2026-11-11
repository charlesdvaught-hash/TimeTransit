import {
  categories,
  distance,
  fastest,
  itineraries,
  matchCategory,
  type Place,
  type Itinerary,
  type ReachableStop,
} from "./core";
import { defaults, walkParams, type Preferences } from "./preferences";
import { logFeed } from "./reliabilityStore";
const cache = new Map<string, unknown>();
let active = 0;
const queue: (() => void)[] = [];
async function json(url: string, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (cache.has(url)) return cache.get(url);
  await new Promise<void>((resolve) => {
    const run = () => {
      active++;
      resolve();
    };
    if (active < 3) run();
    else queue.push(run);
  });
  try {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const response = await fetch(url, {
      signal,
      ...(typeof window === "undefined"
        ? {
            headers: {
              "User-Agent": "TimeTransit/1.0 (local transit explorer)",
            },
          }
        : {}),
    });
    if (!response.ok)
      throw new Error(
        `Service returned ${response.status}: ${(await response.text()).slice(0, 200) || response.statusText}`,
      );
    const data = await response.json();
    cache.set(url, data);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return data;
  } finally {
    active--;
    queue.shift()?.();
  }
}
export function searchParams(
  query: string,
  origin: Place,
  tag = categories[query],
): URLSearchParams {
  const dx = 0.24 / Math.cos((origin.lat * Math.PI) / 180);
  const params = new URLSearchParams({
    lat: String(origin.lat),
    lon: String(origin.lon),
    limit: "50",
    bbox: `${origin.lon - dx},${origin.lat - 0.18},${origin.lon + dx},${origin.lat + 0.18}`,
  });
  if (tag) params.set("include", `osm.${tag.replace(":", ".")}`);
  else params.set("q", query);
  return params;
}
const toPlace = (f: any, fallback: string): Place => ({
  id: `${f.properties.osm_type}${f.properties.osm_id}`,
  name: f.properties.name || f.properties.street || fallback,
  lon: f.geometry.coordinates[0],
  lat: f.geometry.coordinates[1],
  address: [f.properties.housenumber, f.properties.street, f.properties.city]
    .filter(Boolean)
    .join(" "),
});
export async function suggest(
  query: string,
  origin: Place,
  signal?: AbortSignal,
): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const p = new URLSearchParams({
    q,
    lat: String(origin.lat),
    lon: String(origin.lon),
    limit: "6",
  });
  const data = await json(`https://photon.komoot.io/api/?${p}`, signal);
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return (data.features || [])
    .map((f: any) => toPlace(f, q))
    .filter((p: Place) => distance(origin, p) <= 30)
    .filter(
      (p: Place, i: number, a: Place[]) =>
        a.findIndex((x) => x.id === p.id) === i,
    )
    .slice(0, 6);
}
export async function search(
  query: string,
  origin: Place,
  signal?: AbortSignal,
): Promise<Place[]> {
  const requests = matchCategory(query).map((tag) =>
    json(
      `https://photon.komoot.io/api/?${searchParams(query, origin, tag)}`,
      signal,
    ),
  );
  if (!categories[query])
    requests.push(
      json(
        `https://photon.komoot.io/api/?${searchParams(query, origin, "")}`,
        signal,
      ),
    );
  const responses = await Promise.all(requests);
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return responses
    .flatMap((data: any) => data.features || [])
    .map((f: any) => toPlace(f, query))
    .filter((p: Place) => distance(origin, p) <= 20)
    .sort((a: Place, b: Place) => distance(origin, a) - distance(origin, b))
    .filter(
      (p: Place, i: number, a: Place[]) =>
        a.findIndex((x) => x.id === p.id) === i,
    )
    .slice(0, 50);
}
async function planData(
  a: Place,
  b: Place,
  time: Date,
  signal?: AbortSignal,
  preferences: Preferences = defaults,
  onAgencies?: (agencies: string[]) => void,
) {
  const p = new URLSearchParams({
    fromPlace: `${a.lat},${a.lon}`,
    toPlace: `${b.lat},${b.lon}`,
    time: time.toISOString(),
    arriveBy: "false",
    numItineraries: "3",
    ...walkParams(preferences),
  });
  const data = await json(
    `https://api.transitous.org/api/v2/plan?${p}`,
    signal,
  );
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  logFeed([...(data.itineraries || []), ...(data.direct || [])]);
  onAgencies?.([
    ...new Set<string>(
      (data.itineraries || []).flatMap((t: Itinerary) =>
        t.legs.flatMap((l) => (l.agencyName ? [l.agencyName] : [])),
      ),
    ),
  ]);
  return data;
}
export async function plan(
  a: Place,
  b: Place,
  time: Date,
  signal?: AbortSignal,
  preferences: Preferences = defaults,
  onAgencies?: (agencies: string[]) => void,
): Promise<Itinerary> {
  return fastest(
    await planData(a, b, time, signal, preferences, onAgencies),
    time,
  );
}
export async function planOptions(
  a: Place,
  b: Place,
  time: Date,
  signal?: AbortSignal,
  preferences: Preferences = defaults,
  onAgencies?: (agencies: string[]) => void,
): Promise<Itinerary[]> {
  return itineraries(
    await planData(a, b, time, signal, preferences, onAgencies),
    time,
  ).slice(0, 3);
}
export async function searchOrigin(
  query: string,
  origin: Place,
  signal?: AbortSignal,
): Promise<Place[]> {
  const zip = /^\d{5}$/.test(query.trim());
  const p = new URLSearchParams({
    q: zip ? `${query.trim()} United States` : query,
    limit: "8",
  });
  if (zip) p.set("countrycode", "us");
  else {
    p.set("lat", String(origin.lat));
    p.set("lon", String(origin.lon));
  }
  const data = await json(`https://photon.komoot.io/api/?${p}`, signal);
  const features = zip
    ? data.features.filter(
        (f: any) =>
          f.properties.osm_value === "postcode" &&
          f.properties.name === query.trim() &&
          f.properties.countrycode === "US",
      )
    : data.features;
  if (!features.length)
    throw new Error(
      "No matching origin found. Try a city and state or a full address.",
    );
  return features.map((f: any) => ({
    id: `origin-${f.properties.osm_id || f.properties.name}-${f.geometry.coordinates.join(",")}`,
    name: [f.properties.name, f.properties.city, f.properties.state]
      .filter(Boolean)
      .join(" · "),
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  }));
}
export async function reachable(
  origin: Place,
  time: Date,
  signal?: AbortSignal,
  maxMinutes = 45,
): Promise<ReachableStop[]> {
  const p = new URLSearchParams({
    one: `${origin.lat},${origin.lon}`,
    time: time.toISOString(),
    maxTravelTime: String(maxMinutes),
  });
  const data = await json(
    `https://api.transitous.org/api/v6/one-to-all?${p}`,
    signal,
  );
  return (data.all || []).flatMap((entry: any) => {
    const at = entry?.place;
    return at &&
      Number.isFinite(entry.duration) &&
      Number.isFinite(at.lat) &&
      Number.isFinite(at.lon)
      ? [{ lat: at.lat, lon: at.lon, minutes: entry.duration }]
      : [];
  });
}
export async function nearby(
  origin: Place,
  signal?: AbortSignal,
): Promise<string[]> {
  const p = new URLSearchParams({
    min: `${origin.lat - 0.015},${origin.lon - 0.02}`,
    max: `${origin.lat + 0.015},${origin.lon + 0.02}`,
  });
  const stops = await json(
    `https://api.transitous.org/api/v1/map/stops?${p}`,
    signal,
  );
  return [
    ...new Set<string>(
      stops.flatMap((s: any) => (s.agencyName ? [s.agencyName] : [])),
    ),
  ];
}
