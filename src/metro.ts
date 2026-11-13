// LA Metro realtime via api.metro.net's documented WebSocket (beta, keyless,
// and WebSocket needs no CORS). vehicle_positions streams live for LACMTA
// (bus) and LACMTA_Rail; the trip_updates lane is dead upstream (verified
// Nov 2026 — REST mirror + ws both return nothing), so this module is
// positions only: markers, not predictions.
import type { Leg } from "./core";
import { haversine } from "./scan";

export type MetroAgency = "LACMTA" | "LACMTA_Rail";

export type MetroVehicle = {
  id: string;
  tripId?: string;
  routeId?: string;
  routeCode?: string;
  directionId?: number;
  lat: number;
  lon: number;
  bearing?: number;
  speed?: number;
  stopId?: string;
  status?: string;
  ts?: number;
};

const WS = "wss://api.metro.net/ws";

// Rail route_ids carry no short name — letter comes from "Metro X Line".
// From data/metro-rail/routes.txt.
export const METRO_RAIL_CODES = ["801", "802", "803", "804", "805", "807"];
const RAIL_LETTERS: Record<string, string> = {
  a: "801",
  b: "802",
  c: "803",
  d: "805",
  e: "804",
  k: "807",
};

export function routeCodeOf(routeId: string): string {
  return routeId.split("-")[0];
}

export function parseMetroVehicle(raw: unknown): MetroVehicle | null {
  const m = raw as {
    id?: unknown;
    vehicle?: {
      trip?: Record<string, unknown>;
      position?: Record<string, unknown>;
      currentStatus?: unknown;
      stopId?: unknown;
      timestamp?: unknown;
    };
  };
  const v = m?.vehicle;
  const lat = v?.position?.latitude,
    lon = v?.position?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const trip = v?.trip;
  const routeId = typeof trip?.routeId === "string" ? trip.routeId : undefined;
  return {
    id: String(m.id ?? ""),
    tripId: typeof trip?.tripId === "string" ? trip.tripId : undefined,
    routeId,
    routeCode: routeId ? routeCodeOf(routeId) : undefined,
    directionId:
      typeof trip?.directionId === "number" ? trip.directionId : undefined,
    lat,
    lon,
    bearing:
      typeof v?.position?.bearing === "number" ? v.position.bearing : undefined,
    speed:
      typeof v?.position?.speed === "number" ? v.position.speed : undefined,
    stopId: typeof v?.stopId === "string" ? v.stopId : undefined,
    status: typeof v?.currentStatus === "string" ? v.currentStatus : undefined,
    ts:
      v?.timestamp === undefined || v?.timestamp === null
        ? undefined
        : Number(v.timestamp),
  };
}

// leg -> {agency, code} for the ws filter. "Metrolink" contains "metro" —
// exclude it explicitly. Rail legs may carry a lettered name instead of a
// numeric code ("A" / "Metro A Line" -> 801).
export function metroRouteFor(
  leg: Pick<
    Leg,
    | "agencyId"
    | "agencyName"
    | "routeId"
    | "routeShortName"
    | "mode"
    | "headsign"
  >,
): { agency: MetroAgency; code: string } | null {
  const id = leg.agencyId || "",
    name = leg.agencyName || "";
  const metro =
    /^LACMTA/.test(id) || (/metro/i.test(name) && !/metrolink/i.test(name));
  if (!metro) return null;
  const rail =
    /rail/i.test(id) || /subway|light|rail|tram|metro/i.test(leg.mode || "");
  const code =
    (leg.routeId || "").match(/(\d{3,4})/)?.[1] ||
    (leg.routeShortName || "").match(/^\d+/)?.[0];
  if (code) return { agency: rail ? "LACMTA_Rail" : "LACMTA", code };
  if (rail) {
    const letter =
      (leg.routeShortName || "").match(/([a-z])\s*(?:line)?$/i)?.[1] ||
      (leg.headsign || "").match(/([a-z])\s*line/i)?.[1];
    const mapped = letter && RAIL_LETTERS[letter.toLowerCase()];
    if (mapped) return { agency: "LACMTA_Rail", code: mapped };
  }
  return null;
}

const TTL = 20_000;
const cache = new Map<string, { at: number; vehicles: MetroVehicle[] }>();
const inflight = new Map<string, Promise<MetroVehicle[]>>();

// Snapshot cache is module state shared across callers — tests reset it.
export function resetMetroCache() {
  cache.clear();
  inflight.clear();
}

// Snapshot: open the ws, collect positions until the stream goes quiet (the
// feed re-pushes the whole filtered fleet every few seconds), keep the
// newest fix per vehicle, close. Results cached briefly so bursts of
// callers share one connection.
export function metroVehicles(
  agency: MetroAgency,
  codes: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<MetroVehicle[]> {
  if (typeof WebSocket === "undefined" || !codes.length)
    return Promise.resolve([]);
  const key = `${agency}|${[...codes].sort().join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.vehicles);
  const live = inflight.get(key);
  if (live) return live;
  const p = collect(agency, codes, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;

  function collect(
    agency: MetroAgency,
    codes: string[],
    opts: { signal?: AbortSignal },
  ): Promise<MetroVehicle[]> {
    return new Promise((res) => {
      const byId = new Map<string, MetroVehicle>();
      let quiet: ReturnType<typeof setTimeout> | undefined,
        cap: ReturnType<typeof setTimeout> | undefined,
        settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (quiet !== undefined) clearTimeout(quiet);
        if (cap !== undefined) clearTimeout(cap);
        try {
          ws.close();
        } catch {}
        const vehicles = [...byId.values()];
        cache.set(key, { at: Date.now(), vehicles });
        res(vehicles);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(
          `${WS}/${agency}/vehicle_positions/${codes.join(",")}`,
        );
      } catch {
        return res([]);
      }
      const arm = () => {
        if (quiet !== undefined) clearTimeout(quiet);
        quiet = setTimeout(done, 2_500);
      };
      ws.onopen = () => {
        cap = setTimeout(done, 9_000);
        arm();
      };
      ws.onmessage = (e) => {
        try {
          const v = parseMetroVehicle(JSON.parse(String(e.data)));
          if (v && (v.ts ?? 0) >= (byId.get(v.id)?.ts ?? 0)) byId.set(v.id, v);
        } catch {}
        arm();
      };
      ws.onerror = done;
      ws.onclose = done;
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

// Tracked Metro leg -> nearest live vehicle on the same route. Positions
// only — a marker, not a prediction (no trip_updates upstream).
export async function metroBusFor(
  leg: Leg,
  signal?: AbortSignal,
): Promise<{ lat: number; lon: number; bearing?: number } | null> {
  const r = metroRouteFor(leg);
  if (!r) return null;
  const vehicles = await metroVehicles(r.agency, [r.code], { signal });
  const same = vehicles.filter((v) => v.routeCode === r.code);
  if (!same.length) return null;
  let best = same[0],
    d = Infinity;
  for (const v of same) {
    const dd = haversine(leg.from, { la: v.lat, lo: v.lon });
    if (dd < d) {
      d = dd;
      best = v;
    }
  }
  return { lat: best.lat, lon: best.lon, bearing: best.bearing };
}
