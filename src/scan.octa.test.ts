import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { arrivalAtPoint, inCoverage, scan, type ScanIndex } from "./scan";
import { scanOrder } from "./core";

// Runs only when the preprocessed index exists (node scripts/build-scan-index.mjs).
const path = "public/scan/octa.json";
const index: ScanIndex | undefined = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : undefined;
// Anaheim probe point from the API probes.
const ANAHEIM = { lat: 33.8366, lon: -117.9143 };
// A weekday midday departure inside the feed window.
const AT = Date.UTC(2026, 10, 17, 20, 0); // Tue Nov 17 2026, 12:00 PST

describe.runIf(index)("octa scan (real index)", () => {
  const idx = index!;
  it("covers Anaheim, excludes Chicago", () => {
    expect(inCoverage(idx, ANAHEIM)).toBe(true);
    expect(inCoverage(idx, { lat: 41.88, lon: -87.63 })).toBe(false);
  });
  it("reaches real stops on a weekday midday", () => {
    const r = scan(idx, ANAHEIM, AT);
    expect(r.size).toBeGreaterThan(500);
  });
  it("produces a sane cross-county estimate", () => {
    const r = scan(idx, ANAHEIM, AT);
    // Santa Ana probe point (~9km) should be reached in tens of minutes.
    const at = arrivalAtPoint(idx, r, { lat: 33.7455, lon: -117.8677 });
    expect(at).toBeDefined();
    const mins = (at! - AT) / 60000;
    expect(mins).toBeGreaterThan(15);
    expect(mins).toBeLessThan(150);
  });
  it("walks to a nearby point off-network", () => {
    const r = scan(idx, ANAHEIM, AT);
    const at = arrivalAtPoint(idx, r, { lat: 33.837, lon: -117.915 });
    expect(at).toBeDefined();
    expect(at! - AT).toBeLessThan(10 * 60000);
  });
  it("beam-ranks a 3-stop round trip in interactive time", () => {
    const P = (id: string, la: number, lo: number) => ({
      id,
      name: id,
      lat: la,
      lon: lo,
    });
    const mk = (id: string, la: number, lo: number) => ({
      id,
      label: id,
      candidates: [P(id, la, lo)],
      dwell: 15,
    });
    const t0 = performance.now();
    const out = scanOrder(
      idx,
      P("home", 33.8366, -117.9143),
      [
        mk("a", 33.79, -117.86),
        mk("b", 33.75, -117.87),
        mk("c", 33.83, -117.95),
      ],
      AT,
      { back: true, walkSpeed: 1.4, maxWalkM: 800 },
    );
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(out.length).toBeGreaterThan(0);
  });
});
