import { distance, type Leg } from "./core";
export type LiveDeparture = {
  routeName: string;
  headsign?: string;
  stopName: string;
  network?: string;
  scheduledTime: string;
  expectedTime: string;
  delay: number;
  realtime: boolean;
  cancelled: boolean;
};
type TransitStop = {
  global_stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  distance?: number;
};
type ScheduleItem = {
  scheduled_departure_time: number;
  departure_time: number;
  is_real_time: boolean;
  is_cancelled: boolean;
  rt_trip_id?: string;
};
type MergedItinerary = {
  headsign?: string;
  direction_headsign?: string;
  merged_headsign?: string;
  schedule_items: ScheduleItem[];
};
type RouteDeparture = {
  global_stop_id?: string;
  global_route_id?: string;
  route_short_name?: string;
  route_long_name?: string;
  route_display_short_name?: { elements?: (string | null)[] };
  compact_display_short_name?: { elements?: (string | null)[] };
  route_network_name?: string;
  merged_itineraries: MergedItinerary[];
};
const relay = import.meta.env.VITE_TRANSIT_RELAY || "/transit";
let disabled = false;
const cache = new Map<string, unknown>();
async function get(path: string, signal?: AbortSignal): Promise<any> {
  if (disabled) throw new Error("Transit API disabled for this session.");
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (cache.has(path)) return cache.get(path);
  const response = await fetch(`${relay}${path}`, { signal });
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    disabled = true;
    throw new Error("Transit API key missing, rejected, or no relay.");
  }
  if (!response.ok)
    throw new Error(
      `Transit API returned ${response.status}: ${(await response.text()).slice(0, 200) || response.statusText}`,
    );
  const data = await response.json();
  cache.set(path, data);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return data;
}
export function normalizeName(value?: string | null) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function routeNames(route: RouteDeparture) {
  return [
    route.route_short_name,
    route.route_long_name,
    route.route_display_short_name?.elements?.[1],
    route.compact_display_short_name?.elements?.[1],
  ]
    .map(normalizeName)
    .filter(Boolean);
}
function headsigns(itinerary: MergedItinerary) {
  return normalizeName(
    [
      itinerary.headsign,
      itinerary.direction_headsign,
      itinerary.merged_headsign,
    ]
      .filter(Boolean)
      .join(" "),
  );
}
function routeScore(route: RouteDeparture, leg: Leg) {
  const name = normalizeName(leg.routeShortName);
  if (name && routeNames(route).includes(name)) return 2;
  const headsign = normalizeName(leg.headsign);
  if (
    headsign &&
    route.merged_itineraries.some((i) => headsigns(i).includes(headsign))
  )
    return 1;
  return 0;
}
export function pickDeparture(
  routes: RouteDeparture[],
  leg: Leg,
  toleranceSeconds = 600,
): { route: RouteDeparture; item: ScheduleItem } | undefined {
  const target = Date.parse(leg.scheduledStartTime || leg.startTime) / 1000;
  let candidates = routes
    .map((route) => ({ route, score: routeScore(route, leg) }))
    .filter((c) => c.score > 0);
  if (!candidates.length && routes.length === 1)
    candidates = [{ route: routes[0], score: 0 }];
  const headsign = normalizeName(leg.headsign);
  let best:
    { route: RouteDeparture; item: ScheduleItem; diff: number } | undefined;
  for (const { route } of candidates) {
    const itineraries = route.merged_itineraries.filter(
      (i) => i.schedule_items?.length,
    );
    const directed = headsign
      ? itineraries.filter((i) => headsigns(i).includes(headsign))
      : [];
    for (const itinerary of directed.length ? directed : itineraries) {
      for (const item of itinerary.schedule_items) {
        const diff = Math.abs(item.scheduled_departure_time - target);
        if (diff <= toleranceSeconds && (!best || diff < best.diff))
          best = { route, item, diff };
      }
    }
  }
  return best ? { route: best.route, item: best.item } : undefined;
}
export function nearestStop(
  stops: TransitStop[],
  point: { lat: number; lon: number },
  maxMeters = 150,
) {
  return stops
    .map((stop) => ({
      stop,
      meters:
        typeof stop.distance === "number"
          ? stop.distance
          : distance(point, { lat: stop.stop_lat, lon: stop.stop_lon }) * 1000,
    }))
    .filter((s) => s.meters <= maxMeters)
    .sort((a, b) => a.meters - b.meters)[0]?.stop;
}
export async function liveDepartures(
  legs: Leg[],
  signal?: AbortSignal,
): Promise<(LiveDeparture | undefined)[]> {
  const stops = await Promise.all(
    legs.map((leg) =>
      get(
        `/v4/public/nearby_stops?lat=${leg.from.lat}&lon=${leg.from.lon}&max_distance=250`,
        signal,
      )
        .then((s) => nearestStop(s.stops || [], leg.from))
        .catch(() => undefined),
    ),
  );
  const ids = [
    ...new Set(
      stops.filter((s): s is TransitStop => !!s).map((s) => s.global_stop_id),
    ),
  ].slice(0, 100);
  if (!ids.length) return legs.map(() => undefined);
  const at = Math.floor(
    Math.min(
      ...legs.map((leg) => Date.parse(leg.scheduledStartTime || leg.startTime)),
    ) /
      1000 -
      180,
  );
  const departures = await get(
    `/v4/public/stop_departures?global_stop_ids=${ids.map(encodeURIComponent).join(",")}&time=${at}&max_num_departures=10&merge_platform_stops=true`,
    signal,
  );
  const rows = (departures.route_departures || []) as RouteDeparture[];
  return legs.map((leg, i) => {
    const stop = stops[i];
    if (!stop) return;
    const match = pickDeparture(
      rows.filter((r) => r.global_stop_id === stop.global_stop_id),
      leg,
    );
    if (!match) return;
    const scheduled = match.item.scheduled_departure_time * 1000,
      expected = match.item.departure_time * 1000;
    return {
      routeName:
        match.route.route_short_name || match.route.route_long_name || leg.mode,
      headsign: leg.headsign,
      stopName: stop.stop_name,
      network: match.route.route_network_name,
      scheduledTime: new Date(scheduled).toISOString(),
      expectedTime: new Date(expected).toISOString(),
      delay: (expected - scheduled) / 1000,
      realtime: !!match.item.is_real_time,
      cancelled: !!match.item.is_cancelled,
    };
  });
}
export async function liveDeparture(
  leg: Leg,
  signal?: AbortSignal,
): Promise<LiveDeparture | undefined> {
  return (await liveDepartures([leg], signal))[0];
}

// Nearby departures for a map tap — nearest stops + soonest buses.
export type NearbyDeparture = {
  route: string;
  stopName: string;
  time: number;
  realtime: boolean;
};
export async function departuresNear(
  point: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<NearbyDeparture[]> {
  const stops = await get(
    `/v4/public/nearby_stops?lat=${point.lat}&lon=${point.lon}&max_distance=450`,
    signal,
  );
  const top = (stops.stops || []).slice(0, 4) as TransitStop[];
  if (!top.length) return [];
  const at = Math.floor(Date.now() / 1000) - 60;
  const deps = await get(
    `/v4/public/stop_departures?global_stop_ids=${top.map((s) => encodeURIComponent(s.global_stop_id)).join(",")}&time=${at}&max_num_departures=8&merge_platform_stops=true`,
    signal,
  );
  const stopName = new Map(top.map((s) => [s.global_stop_id, s.stop_name]));
  const out: NearbyDeparture[] = [];
  for (const row of (deps.route_departures || []) as RouteDeparture[]) {
    const next = row.merged_itineraries
      .flatMap((i) => i.schedule_items)
      .filter((s) => s.departure_time > at)
      .sort((a, b) => a.departure_time - b.departure_time)[0];
    if (!next) continue;
    out.push({
      route:
        row.route_short_name ||
        row.route_display_short_name?.elements?.[1] ||
        row.route_long_name ||
        "?",
      stopName: stopName.get(row.global_stop_id || "") || "",
      time: next.departure_time * 1000,
      realtime: !!next.is_real_time,
    });
  }
  return out.sort((a, b) => a.time - b.time).slice(0, 6);
}

// Route tap → stops along the line + next live departures near the tap.
export type RouteInfo = {
  name: string;
  agency?: string;
  headsigns: string[];
  stops: { name: string; id: string }[];
  stopName?: string;
  departures: { time: number; realtime: boolean }[];
};
export async function routeInfoAt(
  routeName: string,
  agency: string | undefined,
  point: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<RouteInfo | undefined> {
  const near = await get(
    `/v4/public/nearby_routes?lat=${point.lat}&lon=${point.lon}&max_distance=800`,
    signal,
  );
  const want = normalizeName(routeName);
  const route = (near.routes || []).find((r: RouteDeparture) =>
    routeNames(r).includes(want),
  );
  if (!route?.global_route_id) return;
  const [details, stops] = await Promise.all([
    get(
      `/v4/public/route_details?global_route_id=${encodeURIComponent(route.global_route_id)}`,
      signal,
    ),
    get(
      `/v4/public/nearby_stops?lat=${point.lat}&lon=${point.lon}&max_distance=400`,
      signal,
    ),
  ]);
  const itins = (details.itineraries || []).filter(
    (i: { is_active?: boolean }) => i.is_active !== false,
  );
  const info: RouteInfo = {
    name: route.route_short_name || route.route_long_name || routeName,
    agency,
    headsigns: [
      ...new Set(
        itins
          .map((i: { direction_headsign?: string }) => i.direction_headsign)
          .filter(Boolean),
      ),
    ] as string[],
    stops: [],
    departures: [],
  };
  // stops from the itinerary whose first stop is nearest the tap
  const nearStop = nearestStop(stops.stops || [], point, 400);
  const best = itins
    .map((i: { stops?: { stop_lat: number; stop_lon: number }[] }) => ({
      i,
      m: i.stops?.length
        ? Math.min(
            ...i.stops.map((s) =>
              distance(point, { lat: s.stop_lat, lon: s.stop_lon }),
            ),
          )
        : 9e9,
    }))
    .sort((a: { m: number }, b: { m: number }) => a.m - b.m)[0]?.i;
  info.stops = (best?.stops || []).map(
    (s: { stop_name: string; global_stop_id: string }) => ({
      name: s.stop_name,
      id: s.global_stop_id,
    }),
  );
  if (nearStop) {
    const at = Math.floor(Date.now() / 1000) - 60;
    const deps = await get(
      `/v4/public/stop_departures?global_stop_ids=${encodeURIComponent(nearStop.global_stop_id)}&time=${at}&max_num_departures=10&merge_platform_stops=true`,
      signal,
    );
    const row = ((deps.route_departures || []) as RouteDeparture[]).find((r) =>
      routeNames(r).includes(want),
    );
    if (row) {
      info.stopName = nearStop.stop_name;
      info.departures = row.merged_itineraries
        .flatMap((i) => i.schedule_items)
        .filter((s) => s.departure_time > at)
        .sort((a, b) => a.departure_time - b.departure_time)
        .slice(0, 3)
        .map((s) => ({
          time: s.departure_time * 1000,
          realtime: !!s.is_real_time,
        }));
    }
  }
  return info;
}

// Live bus position via Transit's /v4/vehicles — fallback when the
// keyless GTFS-RT feed has no match (non-OCTA legs, missing trips).
export async function liveVehicle(
  leg: Leg,
  signal?: AbortSignal,
): Promise<{ lat: number; lon: number; label?: string } | undefined> {
  const stops = await get(
    `/v4/public/nearby_stops?lat=${leg.from.lat}&lon=${leg.from.lon}&max_distance=250`,
    signal,
  );
  const stop = nearestStop(stops.stops || [], leg.from);
  if (!stop) return;
  const at = Math.floor(
    Date.parse(leg.scheduledStartTime || leg.startTime) / 1000 - 180,
  );
  const deps = await get(
    `/v4/public/stop_departures?global_stop_ids=${encodeURIComponent(stop.global_stop_id)}&time=${at}&max_num_departures=10&merge_platform_stops=true`,
    signal,
  );
  const match = pickDeparture(
    ((deps.route_departures || []) as RouteDeparture[]).filter(
      (r) => r.global_stop_id === stop.global_stop_id,
    ),
    leg,
  );
  const routeId = match?.route.global_route_id;
  if (!routeId) return;
  // Positions must be fresh — bypass get()'s response cache.
  if (disabled) return;
  const resp = await fetch(
    `${relay}/v4/vehicles?global_route_id=${encodeURIComponent(routeId)}`,
    { signal },
  );
  if (!resp.ok) return;
  const vehicles = ((await resp.json()).vehicles || []) as {
    rt_trip_id?: string;
    latitude: number;
    longitude: number;
    external_vehicle_id?: string;
  }[];
  const v =
    vehicles.find(
      (x) => x.rt_trip_id && x.rt_trip_id === match.item.rt_trip_id,
    ) ?? (vehicles.length === 1 ? vehicles[0] : undefined);
  return v
    ? { lat: v.latitude, lon: v.longitude, label: v.external_vehicle_id }
    : undefined;
}
