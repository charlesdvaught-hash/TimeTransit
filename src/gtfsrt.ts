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
      out.push({ f, wire, v: 0 });
      i += 8;
    } else if (wire === 2) {
      const len = varint();
      out.push({ f, wire, v: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ f, wire, v: 0 });
      i += 4;
    } else break;
  }
  return out;
}
const str = (v: Field["v"]) =>
  v instanceof Uint8Array ? new TextDecoder().decode(v) : "";
const msgs = (list: Field[], f: number) =>
  list.filter((x) => x.f === f && x.v instanceof Uint8Array);
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
