import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chainSources,
  reportSource,
  resetSourceHealth,
  sourceDown,
  trySource,
} from "./liveSource";

afterEach(() => {
  resetSourceHealth();
  vi.useRealTimers();
});

describe("trySource", () => {
  it("returns the value and keeps the source up", async () => {
    expect(await trySource("transit", async () => 1)).toBe(1);
    expect(sourceDown("transit")).toBe(false);
  });
  it("returns undefined on throw and cools the source down", async () => {
    const fn = vi.fn(async () => {
      throw new Error("522");
    });
    expect(await trySource("octa-rt", fn)).toBeUndefined();
    expect(sourceDown("octa-rt")).toBe(true);
    // on cooldown the fn isn't even invoked — no repeat stall
    expect(await trySource("octa-rt", fn)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("bounds a hung call and marks the source down", async () => {
    vi.useFakeTimers();
    const p = trySource("octa-rt", () => new Promise<never>(() => {}), {
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeUndefined();
    expect(sourceDown("octa-rt")).toBe(true);
  });
  it("recovers after the cooldown lapses", () => {
    reportSource("transit", false);
    expect(sourceDown("transit")).toBe(true);
    expect(sourceDown("transit", Date.now() + 61_000)).toBe(false);
  });
});

describe("chainSources", () => {
  it("tries the next source when the first fails", async () => {
    const hit = await chainSources([
      [
        "transit",
        async () => {
          throw new Error("down");
        },
      ],
      ["index", async () => "ok"],
    ]);
    expect(hit).toEqual({ value: "ok", source: "index" });
  });
  it("tries the next source when the first has no answer", async () => {
    const hit = await chainSources([
      ["transit", async () => undefined],
      ["octa-rt", async () => 2],
    ]);
    expect(hit?.value).toBe(2);
    expect(sourceDown("transit")).toBe(false); // answered, just empty
  });
  it("returns undefined when every source fails", async () => {
    expect(
      await chainSources([
        [
          "transit",
          async () => {
            throw new Error("x");
          },
        ],
        ["index", async () => undefined],
      ]),
    ).toBeUndefined();
  });
});
