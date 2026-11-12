import { describe, expect, it } from "vitest";
import { classifyTransfer, transferTiers } from "./transferRisk";
import type { TripChain } from "./core";

const base = { bufferMin: 15, requiresWalk: false, precedingRideMin: 10 };

describe("classifyTransfer", () => {
  it("marks roomy buffers LOW", () => {
    expect(classifyTransfer(base).tier).toBe("LOW");
    expect(classifyTransfer(base).pollIntervalMs).toBe(60_000);
  });
  it("marks tight same-site buffers HIGH_RISK", () => {
    expect(classifyTransfer({ ...base, bufferMin: 6 }).tier).toBe("HIGH_RISK");
  });
  it("walk transfers get a wider HIGH_RISK band", () => {
    const t = classifyTransfer({ ...base, bufferMin: 9, requiresWalk: true });
    expect(t.tier).toBe("HIGH_RISK");
    // same buffer without a walk is MEDIUM
    expect(classifyTransfer({ ...base, bufferMin: 9 }).tier).toBe("MEDIUM");
  });
  it("medium bands sit between the thresholds", () => {
    expect(classifyTransfer({ ...base, bufferMin: 9 }).tier).toBe("MEDIUM");
    expect(
      classifyTransfer({ ...base, bufferMin: 11, requiresWalk: true }).tier,
    ).toBe("MEDIUM");
  });
  it("elevates sub-9-minute buffers on a stale feed", () => {
    expect(
      classifyTransfer({ ...base, bufferMin: 8.5, staleFeed: true }).tier,
    ).toBe("HIGH_RISK");
    // LOW-tier buffers unaffected by staleness at >=9 min... except MEDIUM band
    expect(
      classifyTransfer({ ...base, bufferMin: 13, staleFeed: true }).tier,
    ).toBe("LOW");
  });
  it("treats a missed-connection risk after long rides as HIGH_RISK", () => {
    expect(
      classifyTransfer({ ...base, bufferMin: 11, precedingRideMin: 45 }).tier,
    ).toBe("HIGH_RISK");
  });
  it("poll interval tightens only for HIGH_RISK", () => {
    expect(classifyTransfer({ ...base, bufferMin: 6 }).pollIntervalMs).toBe(
      15_000,
    );
    expect(classifyTransfer({ ...base, bufferMin: 9 }).pollIntervalMs).toBe(
      60_000,
    );
  });
});

describe("transferTiers", () => {
  const leg = (
    start: string,
    end: string,
    dur = 600,
  ): TripChain["visits"][0]["trip"]["legs"][0] =>
    ({
      mode: "BUS",
      duration: dur,
      routeShortName: "55",
      tripId: "t",
      startTime: start,
      endTime: end,
      scheduledStartTime: start,
      from: { lat: 33.7, lon: -117.9, name: "a" },
      to: { lat: 33.71, lon: -117.89, name: "b" },
    }) as never;
  const chain = (walk = false): TripChain =>
    ({
      visits: [
        {
          trip: {
            legs: [leg("2026-06-15T12:00:00", "2026-06-15T12:30:00")],
            startTime: "",
            endTime: "2026-06-15T12:30:00",
          },
        },
        {
          trip: {
            legs: [
              ...(walk
                ? [
                    {
                      mode: "WALK",
                      duration: 180,
                      startTime: "",
                      endTime: "",
                      from: { lat: 0, lon: 0, name: "" },
                      to: { lat: 0, lon: 0, name: "" },
                    } as never,
                  ]
                : []),
              leg("2026-06-15T12:36:00", "2026-06-15T12:50:00"),
            ],
            startTime: "",
            endTime: "2026-06-15T12:50:00",
          },
        },
      ],
    }) as never;
  it("computes the buffer between alight and next boarding", () => {
    const [p] = transferTiers(chain());
    expect(p.scheduledBufferMinutes).toBeCloseTo(6);
    expect(p.tier).toBe("HIGH_RISK");
    expect(p.isSameSite).toBe(true);
  });
  it("a WALK leg between rides marks the transfer as requiring a walk", () => {
    const [p] = transferTiers(chain(true));
    expect(p.requiresWalk).toBe(true);
  });
});
