import { afterEach, describe, expect, it, vi } from "vitest";
import { geolocationGranted } from "./useUserPosition";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geolocationGranted", () => {
  it("returns true when the permission query resolves granted", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });
    expect(await geolocationGranted()).toBe(true);
  });
  it("returns false for prompt/denied and when the API is absent", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "prompt" }),
      },
    });
    expect(await geolocationGranted()).toBe(false);
    vi.stubGlobal("navigator", {}); // Safari: no permissions API at all
    expect(await geolocationGranted()).toBe(false);
  });
  it("returns false when the query throws (unsupported name)", async () => {
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockRejectedValue(new TypeError("x")) },
    });
    expect(await geolocationGranted()).toBe(false);
  });
});
