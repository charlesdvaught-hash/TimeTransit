// Live scan-vs-MOTIS spot check. Run with:
//   npx vitest run src/spotcheck.test.ts --env LIVE=1  (needs network)
// Skipped by default so the offline suite stays green.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { arrivalAtPoint, inCoverage, scan, type ScanIndex } from "./scan";

const LIVE = process.env.LIVE === "1";
const path = "public/scan/octa.json";
const idx: ScanIndex | undefined = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : undefined;

// Anaheim (33.8366,-117.9143) -> Santa Ana (33.7455,-117.8677)
// Transit API oracle said ~3490s; MOTIS should land in the same band.
const O = { lat: 33.8366, lon: -117.9143 };
const D = { lat: 33.7455, lon: -117.8677 };

describe.runIf(LIVE && !!idx)("live spot check", () => {
  it("scan and MOTIS agree within ~15 min on OC trips", async () => {
    const t0 = Date.now() + 10 * 60 * 1000; // 10 min from now
    const result = scan(idx!, O, t0);
    const scanMs = arrivalAtPoint(idx!, result, D)!;
    expect(scanMs).toBeGreaterThan(0);

    const u = new URL("https://api.transitous.org/api/v2/plan");
    u.search = new URLSearchParams({
      fromPlace: `${O.lat},${O.lon}`,
      toPlace: `${D.lat},${D.lon}`,
      time: new Date(t0).toISOString(),
      arriveBy: "false",
      numItineraries: "1",
    }).toString();
    const plan = await fetch(u, {
      headers: { "User-Agent": "TimeTransit/1.0 spotcheck" },
    }).then((r) => r.json());
    const motisMs = plan.itineraries?.[0]
      ? Date.parse(plan.itineraries[0].endTime) - t0
      : undefined;
    expect(motisMs).toBeDefined();

    const gapMin = Math.abs(scanMs! - t0 - motisMs!) / 60000;
    console.log(
      `scan=${Math.round((scanMs! - t0) / 60000)}min motis=${Math.round(motisMs! / 60000)}min gap=${gapMin.toFixed(1)}min`,
    );
    expect(gapMin).toBeLessThan(15);
  }, 30000);

  it("coverage gate: Anaheim in, LA out", () => {
    expect(inCoverage(idx!, O)).toBe(true);
    expect(inCoverage(idx!, { lat: 34.05, lon: -118.24 })).toBe(false);
  });
});
