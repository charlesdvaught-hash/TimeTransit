import { it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPORT = "keystone-report.txt";
const say = (line: string) => appendFileSync(REPORT, line + "\n");
// Serve the app's static indexes (scan/places) from disk so the real
// pipeline — Photon candidates → local OCTA scan → MOTIS legs → keystone
// grouping — runs end-to-end under LIVE=1.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  const local = url.match(/(places\/oc\.json|scan\/octa\.json)$/);
  if (local) {
    const data = await readFile(join("public", local[1]));
    return new Response(data, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

import type { Place, Stop, KeystoneRoute } from "./core";
import type { ScanIndex } from "./scan";
const { search, plan, reachable } = await import("./api");
const { candidateTimer } = await import("./useTripSearch");
const { optimizeKeystones, keystoneIndex, scanOrder } = await import("./core");
const { inCoverage, scan } = await import("./scan");
const { loadPlaces, placesInCorridor, searchPlaces } = await import("./places");
const { resolveTripCandidates } = await import("./tripCandidates");

const WALK = { walkSpeed: 1.3, maxWalkM: 1200 };
const santaAna: Place = {
  id: "sa",
  name: "Downtown Santa Ana",
  lat: 33.7455,
  lon: -117.8677,
};
const fullerton: Place = {
  id: "fu",
  name: "Downtown Fullerton",
  lat: 33.8703,
  lon: -117.9242,
};
const anaheim: Place = {
  id: "an",
  name: "Anaheim Center City",
  lat: 33.8353,
  lon: -117.9145,
};
const newport: Place = {
  id: "nb",
  name: "Newport Beach",
  lat: 33.6189,
  lon: -117.9298,
};

let idx: ScanIndex | undefined;
let resolutionPlans = 0;
beforeAll(async () => {
  // loadScanIndex() is window-gated for the browser; load the same bytes
  idx = JSON.parse(readFileSync("public/scan/octa.json", "utf8")) as ScanIndex;
  await loadPlaces();
  await import("node:fs/promises").then((fs) => fs.writeFile(REPORT, ""));
});

const min = (s: number) => `${Math.round(s / 60)}m`;
async function scenario(
  name: string,
  origin: Place,
  labels: string[],
  back = false,
): Promise<KeystoneRoute[]> {
  resolutionPlans = 0;
  const start = new Date(Date.now() + 20 * 60_000); // leave in ~20min
  const corridor = idx
    ? [...scan(idx, origin, start.getTime(), WALK).keys()].map((si) => ({
        lat: idx!.stops[si].la,
        lon: idx!.stops[si].lo,
      }))
    : [];
  const dedupe = (list: Place[]) => [
    ...new Map(list.map((p) => [p.id, p])).values(),
  ];
  const resolved = await resolveTripCandidates(
    labels.map((label, i): Stop => ({
      id: `seg-${i}`,
      label,
      candidates: [],
      dwell: 30,
    })),
    (q) =>
      search(q, origin).then((r) =>
        dedupe([
          ...placesInCorridor([q], corridor, {
            radiusM: WALK.maxWalkM,
            origin,
          }),
          ...searchPlaces(q, origin),
          ...r,
        ]),
      ),
    // production path: estimate → plan fallback, counting real plan calls
    (() => {
      const estimate = candidateTimer({
        origin,
        start,
        scan: Promise.resolve(
          idx && inCoverage(idx, origin)
            ? { idx, r: scan(idx, origin, start.getTime(), WALK) }
            : undefined,
        ),
        oneToAll: () => reachable(origin, start, undefined, 60).catch(() => []),
        ...WALK,
      });
      return async (p: Place) => {
        const est = await estimate(p);
        if (est !== undefined) return { duration: est };
        resolutionPlans++;
        return plan(origin, p, start);
      };
    })(),
  );
  say(
    `\n=== ${name} — "${labels.join(" + ")}" ${back ? "(round trip) " : ""}===`,
  );
  say(`  resolution plan() calls: ${resolutionPlans} (was up to 24)`);
  resolved.forEach((s) =>
    say(
      `  ${s.label}: pool ${s.pool ?? "?"} → ${s.candidates.length} routable`,
    ),
  );
  const order =
    idx && inCoverage(idx, origin)
      ? scanOrder(idx, origin, resolved, start.getTime(), { back, ...WALK })
      : undefined;
  say(`  combos ranked by real transit scan: ${order?.length ?? 0}`);
  const routes = await optimizeKeystones(
    origin,
    resolved,
    start,
    back,
    (a, b, t) => plan(a, b, t),
    18,
    order,
  );
  const kId = resolved[keystoneIndex(resolved)].id;
  const kLabel = resolved.find((s) => s.id === kId)!.label;
  say(`  keystone stop: "${kLabel}" → ${routes.length} routes`);
  routes.forEach((r, i) => {
    const transfers =
      r.chain.visits.reduce((n, v) => n + v.trip.transfers, 0) +
      (r.chain.returnTrip?.transfers ?? 0);
    say(
      `  Route ${String.fromCharCode(65 + i)} — ${r.keystone.place.name} ` +
        `| ${min(r.chain.duration)} total · ${transfers} transfers · ` +
        `+${r.options} nearby options · score ${Math.round(r.score)}`,
    );
    r.chain.visits.forEach((v) => {
      const anchor = v.stop.id === kId ? " [ANCHOR]" : "";
      say(
        `      ${v.stop.label}: ${v.place.name} (${min(v.trip.duration)} leg, ${v.trip.transfers}x)${anchor}`,
      );
    });
    if (r.chain.returnTrip)
      say(`      home: ${min(r.chain.returnTrip.duration)} leg`);
  });
  // invariants worth asserting
  expect(routes.length).toBeGreaterThan(0);
  for (const r of routes) {
    expect(r.chain.visits.map((v) => v.stop.id).sort()).toEqual(
      resolved.map((s) => s.id).sort(),
    );
    expect(r.options).toBeGreaterThanOrEqual(0);
  }
  for (let i = 1; i < routes.length; i++)
    expect(routes[i].score).toBeGreaterThanOrEqual(routes[i - 1].score);
  return routes;
}

const LIVE = "process" in globalThis && (globalThis as any).process.env.LIVE;

it.skipIf(!LIVE)(
  "Santa Ana: post office + fast food + museum + craft store (Dave's flagship prompt)",
  () =>
    scenario("Downtown Santa Ana", santaAna, [
      "post office",
      "fast food",
      "museum",
      "craft store",
    ]),
  600000,
);

it.skipIf(!LIVE)(
  "Fullerton: lunch + museum, round trip (the original complaint)",
  () => scenario("Downtown Fullerton", fullerton, ["lunch", "museum"], true),
  600000,
);

it.skipIf(!LIVE)(
  "Anaheim: coffee + pharmacy + grocery (all-common — tie keystone)",
  () => scenario("Anaheim", anaheim, ["coffee", "pharmacy", "grocery"]),
  600000,
);

it.skipIf(!LIVE)(
  "Newport Beach: hardware store + tacos (transit-sparse area)",
  () => scenario("Newport Beach", newport, ["hardware store", "tacos"]),
  600000,
);
