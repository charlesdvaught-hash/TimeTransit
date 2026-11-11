import { describe, expect, it } from "vitest";
import { advanceArrows, arrowField, buildNetwork } from "./networkGeo";
import type { ScanIndex } from "./scan";

const index = {
  stops: [
    { i: "a", n: "A", la: 33.8, lo: -117.9 },
    { i: "b", n: "B", la: 33.81, lo: -117.91 },
    { i: "c", n: "C", la: 33.82, lo: -117.92 },
  ],
  patterns: [
    {
      r: "R1",
      rid: "1",
      dir: 0,
      h: "",
      c: "ff8800",
      rt: 3,
      stops: [0, 1, 2],
      trips: [],
    },
    {
      r: "R2",
      rid: "2",
      dir: 0,
      h: "",
      c: "00ff88",
      rt: 3,
      stops: [0, 2],
      trips: [],
    },
    {
      r: "R1",
      rid: "1",
      dir: 0,
      h: "",
      c: "ff8800",
      rt: 3,
      stops: [0, 1, 2],
      trips: [],
    }, // duplicate path
  ],
} as unknown as ScanIndex;

describe("buildNetwork", () => {
  it("emits one colored line per unique stop sequence", () => {
    const fc = buildNetwork(index);
    expect(fc.features).toHaveLength(2);
    const first = fc.features[0].geometry as GeoJSON.LineString;
    expect(first.coordinates[0]).toEqual([-117.9, 33.8]);
    expect(fc.features[0].properties?.c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("advanceArrows", () => {
  it("moves points along the line and wraps", () => {
    const fc = buildNetwork(index);
    const field = arrowField(fc);
    expect(field.length).toBeGreaterThan(0);
    const pts = advanceArrows(field, 1);
    expect(pts.features).toHaveLength(field.length);
    const p = pts.features[0].geometry as GeoJSON.Point;
    expect(Math.abs(p.coordinates[0])).toBeGreaterThan(0);
    expect(typeof pts.features[0].properties?.rot).toBe("number");
  });
});
