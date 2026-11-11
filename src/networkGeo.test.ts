import { describe, expect, it } from "vitest";
import { buildNetwork } from "./networkGeo";
import type { ScanIndex } from "./scan";

const index = {
  stops: [
    { i: "a", n: "A", la: 33.8, lo: -117.9 },
    { i: "b", n: "B", la: 33.81, lo: -117.91 },
    { i: "c", n: "C", la: 33.82, lo: -117.92 },
  ],
  patterns: [
    { id: "1", name: "R1", stops: [0, 1, 2], trips: [] },
    { id: "2", name: "R2", stops: [2, 1, 0], trips: [] }, // reverse — same edges
    { id: "3", name: "R3", stops: [0, 2], trips: [] },
  ],
} as unknown as ScanIndex;

describe("buildNetwork", () => {
  it("emits each unique stop-to-stop edge once (undirected)", () => {
    const fc = buildNetwork(index);
    // a-b, b-c, a-c — the reverse pattern adds nothing new
    expect(fc.features).toHaveLength(3);
    const first = fc.features[0].geometry as GeoJSON.LineString;
    expect(first.coordinates[0]).toEqual([-117.9, 33.8]);
  });
});
