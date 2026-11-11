import { describe, expect, it } from "vitest";
import { decodeTripUpdates, decodeVehiclePositions } from "./gtfsrt";

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
    ...msg(2, [
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
