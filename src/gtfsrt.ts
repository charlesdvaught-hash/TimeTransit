// Minimal GTFS-RT FeedMessage decoder — extracts per-stop delays for the scan.
// trip_id -> stop_id -> { d?: delay seconds, t?: absolute event time seconds }
export type TripDelays = Map<string, Map<string, { d?: number; t?: number }>>;

type Field = { f: number; wire: number; v: number | Uint8Array };
function fields(buf: Uint8Array, start = 0, end = buf.length): Field[] {
  const out: Field[] = [];
  let i = start;
  const varint = () => {
    let v = 0,
      s = 0n,
      b = 0;
    do {
      b = buf[i++];
      v = Number(BigInt(v) | (BigInt(b & 0x7f) << s));
      s += 7n;
    } while (b & 0x80 && i < end);
    return v;
  };
  while (i < end) {
    const tag = varint();
    const f = tag >> 3,
      wire = tag & 7;
    if (wire === 0) out.push({ f, wire, v: varint() });
    else if (wire === 1) {
      out.push({ f, wire, v: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = varint();
      out.push({ f, wire, v: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ f, wire, v: buf.subarray(i, i + 4) });
      i += 4;
    } else break;
  }
  return out;
}
const str = (v: Field["v"]) =>
  v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
const msgs = (list: Field[], f: number) =>
  list.filter((x) => x.f === f && x.wire === 2);
const num = (list: Field[], f: number) =>
  list.find((x) => x.f === f && typeof x.v === "number")?.v as
    number | undefined;

export function decodeTripUpdates(buf: Uint8Array): TripDelays {
  const delays: TripDelays = new Map();
  for (const ent of msgs(fields(buf), 2)) {
    const entF = fields(ent.v as Uint8Array);
    for (const tu of msgs(entF, 3)) {
      const tuF = fields(tu.v as Uint8Array);
      const tripMsg = msgs(tuF, 1)[0];
      const tripId = tripMsg
        ? str(
            fields(tripMsg.v as Uint8Array).find((x) => x.f === 1)?.v ??
              new Uint8Array(),
          )
        : "";
      if (!tripId) continue;
      const per = delays.get(tripId) || new Map();
      delays.set(tripId, per);
      for (const stu of msgs(tuF, 2)) {
        const sF = fields(stu.v as Uint8Array);
        const stopId = sF.find((x) => x.f === 4);
        if (!stopId) continue;
        const upd: { d?: number; t?: number } = {};
        for (const ev of [msgs(sF, 2)[0], msgs(sF, 3)[0]]) {
          if (!ev) continue;
          const eF = fields(ev.v as Uint8Array);
          const d = num(eF, 1),
            t = num(eF, 2);
          if (d !== undefined) upd.d = d;
          else if (t !== undefined) upd.t = t;
        }
        if (upd.d !== undefined || upd.t !== undefined)
          per.set(str(stopId.v), upd);
      }
      if (!per.size) delays.delete(tripId);
    }
  }
  return delays;
}

const f32 = (list: Field[], f: number) => {
  const v = list.find(
    (x) => x.f === f && x.wire === 5 && x.v instanceof Uint8Array,
  )?.v as Uint8Array | undefined;
  return v
    ? new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true)
    : undefined;
};

export type VehiclePos = {
  trip: string;
  lat: number;
  lon: number;
  bearing?: number;
};
// trip_id -> current vehicle position
export function decodeVehiclePositions(
  buf: Uint8Array,
): Map<string, VehiclePos> {
  const out = new Map<string, VehiclePos>();
  for (const ent of msgs(fields(buf), 2)) {
    const veh = msgs(fields(ent.v as Uint8Array), 4)[0];
    if (!veh) continue;
    const vF = fields(veh.v as Uint8Array);
    const tripMsg = msgs(vF, 1)[0];
    const tripId = tripMsg
      ? str(
          fields(tripMsg.v as Uint8Array).find((x) => x.f === 1)?.v ??
            new Uint8Array(),
        )
      : "";
    const pos = msgs(vF, 2)[0];
    if (!tripId || !pos) continue;
    const pF = fields(pos.v as Uint8Array);
    const lat = f32(pF, 1),
      lon = f32(pF, 2),
      bearing = f32(pF, 3);
    if (lat === undefined || lon === undefined) continue;
    out.set(tripId, { trip: tripId, lat, lon, bearing });
  }
  return out;
}

// Wave-2: service alerts — entity.alert with informed_entity selectors,
// TranslatedString header/description, and active_period windows.
export type ServiceAlert = {
  routeIds: string[];
  stopIds: string[];
  header: string;
  description: string;
  periods: { start?: number; end?: number }[];
};

// TranslatedString — prefer the English translation, else the first.
// Translations may also arrive split across repeated field instances.
function translated(msgs_: Field[]): string {
  const trs = msgs_.flatMap((m) =>
    msgs(fields(m.v as Uint8Array), 1).map((t) => fields(t.v as Uint8Array)),
  );
  const pick =
    trs.find(
      (t) => str(t.find((x) => x.f === 2)?.v ?? new Uint8Array()) === "en",
    ) ?? trs[0];
  return pick ? str(pick.find((x) => x.f === 1)?.v ?? new Uint8Array()) : "";
}

export function decodeAlerts(buf: Uint8Array): ServiceAlert[] {
  const out: ServiceAlert[] = [];
  for (const ent of msgs(fields(buf), 2)) {
    const alert = msgs(fields(ent.v as Uint8Array), 5)[0];
    if (!alert) continue;
    const aF = fields(alert.v as Uint8Array);
    const routeIds: string[] = [],
      stopIds: string[] = [];
    for (const sel of msgs(aF, 5)) {
      const sF = fields(sel.v as Uint8Array);
      const r = sF.find((x) => x.f === 2),
        s = sF.find((x) => x.f === 5);
      if (r) routeIds.push(str(r.v));
      if (s) stopIds.push(str(s.v));
    }
    const periods = msgs(aF, 1).map((p) => {
      const pF = fields(p.v as Uint8Array);
      return { start: num(pF, 1), end: num(pF, 2) };
    });
    const header = translated(msgs(aF, 10));
    const description = translated(msgs(aF, 11));
    if (!header && !description) continue;
    out.push({ routeIds, stopIds, header, description, periods });
  }
  return out;
}

const normId = (v?: string) =>
  (v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// equal, or one is the other with a namespaced prefix ("octa:55" vs "55") —
// a bare numeric tail like "1" inside "10" must not match
const idHit = (a: string, b: string) =>
  a === b ||
  (a.endsWith(b) && /[a-z]/.test(a.slice(0, -b.length))) ||
  (b.endsWith(a) && /[a-z]/.test(b.slice(0, -a.length)));

export function alertsFor(
  alerts: ServiceAlert[],
  query: {
    routeId?: string;
    routeName?: string;
    stopId?: string;
    at?: number;
  },
): ServiceAlert[] {
  const at = query.at ?? Date.now() / 1000;
  const routes = [query.routeId, query.routeName].map(normId).filter(Boolean);
  const stop = normId(query.stopId);
  return alerts.filter((a) => {
    const active =
      !a.periods.length ||
      a.periods.some(
        (p) =>
          (p.start === undefined || at >= p.start) &&
          (p.end === undefined || at <= p.end),
      );
    if (!active) return false;
    // no selectors = system-wide alert — show it on every row
    if (!a.routeIds.length && !a.stopIds.length) return true;
    return (
      (routes.length > 0 &&
        a.routeIds.some((r) => routes.some((q) => idHit(normId(r), q)))) ||
      (!!stop && a.stopIds.some((s) => normId(s) === stop))
    );
  });
}

let alertCache: { at: number; data: ServiceAlert[] } | null = null;

const base = import.meta.env.VITE_TRANSIT_RELAY
  ? `${import.meta.env.VITE_TRANSIT_RELAY}/gtfsrt`
  : "/gtfsrt";
export async function fetchTripDelays(
  signal?: AbortSignal,
): Promise<TripDelays> {
  const r = await fetch(`${base}/tripupdates`, { signal });
  if (!r.ok) throw new Error(`GTFS-RT ${r.status}`);
  return decodeTripUpdates(new Uint8Array(await r.arrayBuffer()));
}

export async function fetchVehiclePositions(
  signal?: AbortSignal,
): Promise<Map<string, VehiclePos>> {
  const r = await fetch(`${base}/VehiclePositions`, { signal });
  if (!r.ok) throw new Error(`GTFS-RT ${r.status}`);
  return decodeVehiclePositions(new Uint8Array(await r.arrayBuffer()));
}

// Alerts are additive UI garnish — every failure returns the last good
// snapshot or [], never throws, never logs.
export async function fetchAlerts(
  signal?: AbortSignal,
): Promise<ServiceAlert[]> {
  if (alertCache && Date.now() - alertCache.at < 5 * 60 * 1000)
    return alertCache.data;
  try {
    const r = await fetch(`${base}/servicealerts`, { signal });
    if (!r.ok) return alertCache?.data ?? [];
    const data = decodeAlerts(new Uint8Array(await r.arrayBuffer()));
    alertCache = { at: Date.now(), data };
    return data;
  } catch {
    return alertCache?.data ?? [];
  }
}
