import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adventureGap,
  adventureQuery,
  applyAdventure,
  validateAdventure,
  type ChatMessage,
} from "./assistant";
import type { AdventurePlan } from "./contracts";
import type { Itinerary, TripChain } from "./core";

// relay emits every optional key as null rather than absent
const valid = {
  stops: [
    { query: "lunch", type: "category", dwell_min: 45, position: "first" },
    { query: "Museum of Art", type: "anchor", dwell_min: 90, position: null },
    { query: "coffee shop", type: "category", dwell_min: 20, position: "last" },
  ],
  round_trip: true,
  depart_at: null,
  return_by: null,
  notes: null,
};

function llmResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const plan = (over: Partial<AdventurePlan> = {}): AdventurePlan => ({
  stops: [{ query: "lunch", type: "category", dwell_min: 30 }],
  round_trip: false,
  ...over,
});

const itinerary = (endTime: string): Itinerary => ({
  duration: 600,
  startTime: "2026-11-10T17:00:00",
  endTime,
  transfers: 0,
  legs: [],
});

const chain = (endTime: string, returnEnd?: string): TripChain => ({
  visits: [
    {
      stop: { id: "s0", label: "x", candidates: [], dwell: 10 },
      place: { id: "p", name: "x", lat: 0, lon: 0 },
      trip: itinerary(endTime),
    },
  ],
  returnTrip: returnEnd ? itinerary(returnEnd) : undefined,
  duration: 0,
});

describe("validateAdventure", () => {
  it("accepts a well-formed plan and coerces null optionals", () => {
    const v = validateAdventure(valid);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.result.stops[0].position).toBe("first");
      expect(v.result.stops[1].position).toBeUndefined();
      expect(v.result.depart_at).toBeUndefined();
      expect(v.result.return_by).toBeUndefined();
      expect(v.result.notes).toBeUndefined();
    }
  });
  it("rejects non-objects and out-of-range stop counts", () => {
    expect(validateAdventure(null).ok).toBe(false);
    expect(validateAdventure("x").ok).toBe(false);
    expect(validateAdventure([1]).ok).toBe(false);
    expect(validateAdventure({ ...valid, stops: [] }).ok).toBe(false);
    expect(
      validateAdventure({
        ...valid,
        stops: [...valid.stops, ...valid.stops],
      }).ok,
    ).toBe(false);
  });
  it("rejects bad stop fields", () => {
    const bad = (s: object) =>
      validateAdventure({ ...valid, stops: [{ ...valid.stops[0], ...s }] });
    expect(bad({ query: " " }).ok).toBe(false);
    expect(bad({ type: "place" }).ok).toBe(false);
    expect(bad({ dwell_min: Number.NaN }).ok).toBe(false);
    expect(bad({ dwell_min: "30" }).ok).toBe(false);
    expect(bad({ position: "second" }).ok).toBe(false);
  });
  it("requires boolean round_trip and string-or-null optionals", () => {
    expect(validateAdventure({ ...valid, round_trip: "yes" }).ok).toBe(false);
    expect(validateAdventure({ ...valid, depart_at: 5 }).ok).toBe(false);
    expect(validateAdventure({ ...valid, return_by: {} }).ok).toBe(false);
    expect(validateAdventure({ ...valid, notes: 42 }).ok).toBe(false);
  });
});

describe("applyAdventure", () => {
  it("maps stops to term syntax, dwells, pins, and round trip", () => {
    const v = validateAdventure(valid);
    if (!v.ok) throw new Error("fixture should validate");
    const a = applyAdventure(v.result);
    expect(a.term).toBe("^ lunch + Museum of Art + $ coffee shop");
    expect(a.dwells).toEqual([45, 90, 20]);
    expect(a.pins).toEqual(["first", undefined, "last"]);
    expect(a.back).toBe(true);
    expect(a.departIso).toBe("");
  });
  it("omits position prefixes on single-stop plans (explore path)", () => {
    const a = applyAdventure(
      plan({
        stops: [
          {
            query: "lunch",
            type: "category",
            dwell_min: 30,
            position: "first",
          },
        ],
      }),
    );
    expect(a.term).toBe("lunch");
    expect(a.pins).toEqual(["first"]);
  });
  it("formats depart_at as a local datetime-local value", () => {
    expect(
      applyAdventure(plan({ depart_at: "2026-11-10T18:30" })).departIso,
    ).toBe("2026-11-10T18:30");
    expect(applyAdventure(plan({ depart_at: "not a time" })).departIso).toBe(
      "",
    );
  });
});

describe("adventureGap", () => {
  const target = plan({ return_by: "2026-11-10T18:00" });
  it("is null without a return_by or a chain", () => {
    expect(adventureGap(plan(), chain("2026-11-10T19:00:00"))).toBeNull();
    expect(adventureGap(target, null)).toBeNull();
  });
  it("flags a chain that ends past the target", () => {
    const gap = adventureGap(target, chain("2026-11-10T18:22:00"));
    expect(gap).toContain("22 min");
    expect(gap).toContain("target");
  });
  it("measures against the return trip when present", () => {
    const gap = adventureGap(
      target,
      chain("2026-11-10T17:00:00", "2026-11-10T18:05:00"),
    );
    expect(gap).toContain("5 min");
  });
  it("is quiet when the chain ends in time", () => {
    expect(
      adventureGap(target, chain("2026-11-10T17:59:00", "2026-11-10T17:55:00")),
    ).toBeNull();
  });
});

describe("adventureQuery", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_TRANSIT_RELAY", "https://relay.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("returns null without a relay and never fetches", async () => {
    vi.stubEnv("VITE_TRANSIT_RELAY", "");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await adventureQuery("museum day", [])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it("posts the assist task with history and returns a plan", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse(valid));
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    const r = await adventureQuery("museum day", history);
    expect(r?.stops).toHaveLength(3);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://relay.test/llm");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      task: "assist",
      input: "museum day",
      history,
    });
  });
  it("retries once with repair errors after invalid output", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(llmResponse({ ...valid, stops: [] }))
      .mockResolvedValueOnce(llmResponse(valid));
    const r = await adventureQuery("fix this plan", []);
    expect(r?.round_trip).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(spy.mock.calls[1][1]?.body));
    expect(body.task).toBe("assist");
    expect(body.repair.errors.length).toBeGreaterThan(0);
  });
  it("gives up when the repaired output is still invalid", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse({ ...valid, stops: "nope" }));
    expect(await adventureQuery("still invalid plan")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("returns null on non-2xx and network failures without repair", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse({ error: "x" }, 502));
    expect(await adventureQuery("gateway blows up")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear().mockRejectedValue(new TypeError("offline"));
    expect(await adventureQuery("network down")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
