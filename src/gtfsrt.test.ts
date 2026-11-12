import { describe, expect, it } from "vitest";
import {
  alertsFor,
  decodeAlerts,
  decodeTripUpdates,
  decodeVehiclePositions,
} from "./gtfsrt";

// hand-encode protobuf: field(num,wire) helpers
const v = (n: number) => {
  const b: number[] = [];
  do {
    let x = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) x |= 0x80;
    b.push(x);
  } while (n);
  return b;
};
const tag = (f: number, w: number) => v((f << 3) | w);
const msg = (f: number, body: number[]) => [
  ...tag(f, 2),
  ...v(body.length),
  ...body,
];
const s = (f: number, text: string) =>
  msg(f, [...new TextEncoder().encode(text)]);
const i32 = (f: number, n: number) => [...tag(f, 0), ...v(n)];

// entity{ id:"e1" trip_update{ trip{trip_id:"T1"} stop_time_update[
//   {stop_id:"6309" arrival{delay:120}}
//   {stop_id:"6310" departure{time:1794400000}}
// ]}}
const feed = new Uint8Array([
  ...msg(1, [...s(1, "2.0")]), // header
  ...msg(2, [
    ...s(1, "e1"),
    ...msg(3, [
      ...msg(1, [...s(1, "T1")]),
      ...msg(2, [...s(4, "6309"), ...msg(2, [...i32(1, 120)])]),
      ...msg(2, [...s(4, "6310"), ...msg(3, [...i32(2, 1794400000)])]),
    ]),
  ]),
]);

describe("decodeTripUpdates", () => {
  it("extracts trip and per-stop delays/times", () => {
    const d = decodeTripUpdates(feed);
    expect(d.get("T1")?.get("6309")).toEqual({ d: 120 });
    expect(d.get("T1")?.get("6310")).toEqual({ t: 1794400000 });
  });
  it("returns empty for garbage", () => {
    expect(decodeTripUpdates(new Uint8Array([1, 2, 3])).size).toBe(0);
  });
});

// vehicle_positions: entity{ vehicle{ trip{trip_id:"T9"} position{lat,lon,bearing} } }
const f32 = (f: number, n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return [...tag(f, 5), ...b];
};
const vfeed = new Uint8Array([
  ...msg(1, [...s(1, "2.0")]),
  ...msg(2, [
    ...msg(4, [
      ...msg(1, [...s(1, "T9")]),
      ...msg(2, [...f32(1, 33.8355), ...f32(2, -117.9134), ...f32(3, 90)]),
    ]),
  ]),
]);

describe("decodeVehiclePositions", () => {
  it("extracts trip id and float position", () => {
    const m = decodeVehiclePositions(vfeed);
    const v = m.get("T9");
    expect(v?.lat).toBeCloseTo(33.8355, 4);
    expect(v?.lon).toBeCloseTo(-117.9134, 4);
    expect(v?.bearing).toBe(90);
  });
});

// WAVE-2: alerts feed — entity{ alert{ active_period, informed_entity,
// header_text, description_text } } with TranslatedString translations
const ts = (f: number, text: string, lang?: string) =>
  msg(f, [...msg(1, [...s(1, text), ...(lang ? s(2, lang) : [])])]);
const tss = (f: number, trs: [string, string?][]) =>
  msg(
    f,
    trs.flatMap(([text, lang]) => [
      ...msg(1, [...s(1, text), ...(lang ? s(2, lang) : [])]),
    ]),
  );
const afeed = new Uint8Array([
  ...msg(1, [...s(1, "2.0")]),
  ...msg(2, [
    ...s(1, "a1"),
    ...msg(5, [
      ...msg(1, [...i32(1, 100), ...i32(2, 200)]), // active_period
      ...msg(5, [...s(2, "55")]), // informed_entity route_id
      ...msg(5, [...s(5, "6309")]), // informed_entity stop_id
      ...ts(10, "Detour on route 55", "en"),
      ...ts(11, "Buses detour via Main St", "en"),
    ]),
  ]),
  ...msg(2, [
    ...s(1, "a2"),
    ...msg(5, [
      ...msg(5, [...s(2, "10")]), // route_id 10
      ...tss(10, [
        ["Aviso", "es"],
        ["Notice on 10", "en"],
      ]),
    ]),
  ]),
  ...msg(2, [
    ...s(1, "a3"),
    ...msg(5, [
      ...ts(10, "System-wide"), // no informed_entity → matches everything
    ]),
  ]),
]);

describe("decodeAlerts", () => {
  it("extracts selectors, text and active periods", () => {
    const alerts = decodeAlerts(afeed);
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toMatchObject({
      routeIds: ["55"],
      stopIds: ["6309"],
      header: "Detour on route 55",
      description: "Buses detour via Main St",
      periods: [{ start: 100, end: 200 }],
    });
    expect(alerts[1].header).toBe("Notice on 10"); // prefers en
  });
  it("returns empty for garbage", () => {
    expect(decodeAlerts(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe("alertsFor", () => {
  const alerts = decodeAlerts(afeed);
  it("matches route id / short name inside the active period", () => {
    const hits = alertsFor(alerts, { routeId: "55", at: 150 });
    expect(hits.map((a) => a.header)).toEqual([
      "Detour on route 55",
      "System-wide",
    ]);
  });
  it("matches by stop id and by route name", () => {
    expect(alertsFor(alerts, { stopId: "6309", at: 150 })[0]?.header).toBe(
      "Detour on route 55",
    );
    expect(
      alertsFor(alerts, { routeName: "55", at: 150 }).length,
    ).toBeGreaterThan(0);
  });
  it("drops alerts outside their active period", () => {
    expect(
      alertsFor(alerts, { routeId: "55", at: 300 }).map((a) => a.header),
    ).toEqual(["System-wide"]);
  });
  it("matches namespaced route ids but not numeric tails", () => {
    expect(
      alertsFor(alerts, { routeId: "octa:55", at: 150 }).length,
    ).toBeGreaterThan(0);
    // route "1" must not match route_id "10"
    expect(
      alertsFor(alerts, { routeId: "1", at: 150 }).map((a) => a.header),
    ).toEqual(["System-wide"]);
  });
});
