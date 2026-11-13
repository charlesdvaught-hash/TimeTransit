import { afterEach, describe, expect, it, vi } from "vitest";
import type { Leg } from "./core";
import {
  metroBusFor,
  metroRouteFor,
  metroVehicles,
  parseMetroVehicle,
  resetMetroCache,
  routeCodeOf,
} from "./metro";

// real payload shape captured from wss://api.metro.net/ws/LACMTA/vehicle_positions/720
const MSG = {
  id: "9501",
  vehicle: {
    trip: {
      tripId: "10720013731718-JUNE26",
      routeId: "720-13201",
      directionId: 0,
    },
    position: {
      latitude: 34.066,
      longitude: -118.38,
      bearing: 106,
      speed: 2.5,
    },
    currentStopSequence: 7,
    currentStatus: "IN_TRANSIT_TO",
    timestamp: "1773000000",
    stopId: "8431",
  },
};

class FakeWS {
  static instances: FakeWS[] = [];
  closed = false;
  onopen?: () => void;
  onclose?: (e?: unknown) => void;
  onerror?: (e?: unknown) => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    FakeWS.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const leg = (over: Partial<Leg>): Leg => ({
  mode: "BUS",
  duration: 600,
  startTime: "",
  endTime: "",
  from: { id: "a", name: "A", lat: 34.05, lon: -118.25 },
  to: { id: "b", name: "B", lat: 34.06, lon: -118.4 },
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetMetroCache();
  FakeWS.instances = [];
});

describe("parseMetroVehicle", () => {
  it("decodes a vehicle_positions message", () => {
    const v = parseMetroVehicle(MSG)!;
    expect(v.id).toBe("9501");
    expect(v.tripId).toBe("10720013731718-JUNE26");
    expect(v.routeId).toBe("720-13201");
    expect(v.routeCode).toBe("720");
    expect(v.lat).toBeCloseTo(34.066);
    expect(v.lon).toBeCloseTo(-118.38);
    expect(v.bearing).toBe(106);
    expect(v.speed).toBe(2.5);
    expect(v.status).toBe("IN_TRANSIT_TO");
    expect(v.stopId).toBe("8431");
    expect(v.ts).toBe(1773000000);
  });

  it("rejects messages without a position", () => {
    expect(parseMetroVehicle({ id: "1", vehicle: { trip: {} } })).toBeNull();
    expect(parseMetroVehicle(null)).toBeNull();
    expect(parseMetroVehicle({})).toBeNull();
  });
});

describe("routeCodeOf", () => {
  it("strips the feed-version suffix", () => {
    expect(routeCodeOf("720-13201")).toBe("720");
    expect(routeCodeOf("801")).toBe("801");
  });
});

describe("metroRouteFor", () => {
  it("matches Metro bus legs by agency id or name", () => {
    expect(
      metroRouteFor(leg({ agencyId: "LACMTA", routeId: "720-13201" })),
    ).toEqual({ agency: "LACMTA", code: "720" });
    expect(
      metroRouteFor(
        leg({ agencyName: "Metro - Los Angeles", routeShortName: "204" }),
      ),
    ).toEqual({ agency: "LACMTA", code: "204" });
  });

  it("excludes Metrolink despite the 'metro' substring", () => {
    expect(
      metroRouteFor(
        leg({ agencyName: "Metrolink", routeShortName: "OC Line" }),
      ),
    ).toBeNull();
    expect(metroRouteFor(leg({ agencyName: "OCTA" }))).toBeNull();
  });

  it("maps rail legs to LACMTA_Rail via numeric code or line letter", () => {
    expect(
      metroRouteFor(
        leg({ agencyId: "LACMTA_Rail", mode: "SUBWAY", routeId: "801" }),
      ),
    ).toEqual({ agency: "LACMTA_Rail", code: "801" });
    expect(
      metroRouteFor(
        leg({
          agencyName: "Metro Rail",
          mode: "LIGHT_RAIL",
          routeShortName: "K Line",
        }),
      ),
    ).toEqual({ agency: "LACMTA_Rail", code: "807" });
    expect(
      metroRouteFor(
        leg({
          agencyName: "Metro - Los Angeles",
          mode: "SUBWAY",
          routeShortName: "B",
        }),
      ),
    ).toEqual({ agency: "LACMTA_Rail", code: "802" });
  });

  it("returns null when no route code resolves", () => {
    expect(
      metroRouteFor(
        leg({ agencyName: "Metro - Los Angeles", routeShortName: "Local" }),
      ),
    ).toBeNull();
  });
});

describe("metroVehicles", () => {
  it("collects the quiet-window burst, newest fix per vehicle", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    vi.useFakeTimers();
    const p = metroVehicles("LACMTA", ["720"]);
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWS.instances.at(-1)!;
    expect(ws.url).toBe("wss://api.metro.net/ws/LACMTA/vehicle_positions/720");
    ws.emit({ ...MSG, id: "a", vehicle: { ...MSG.vehicle, timestamp: "100" } });
    ws.emit({ ...MSG, id: "b" });
    ws.emit({ ...MSG, id: "a", vehicle: { ...MSG.vehicle, timestamp: "50" } });
    await vi.advanceTimersByTimeAsync(2_600);
    const res = await p;
    expect(res).toHaveLength(2);
    expect(res.find((v) => v.id === "a")!.ts).toBe(100); // older fix dropped
    expect(ws.closed).toBe(true);
  });

  it("resolves empty when the socket errors", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    vi.useFakeTimers();
    const p = metroVehicles("LACMTA", ["204"]);
    await vi.advanceTimersByTimeAsync(1);
    FakeWS.instances.at(-1)!.onerror?.({});
    expect(await p).toEqual([]);
  });
});

describe("metroBusFor", () => {
  it("picks the nearest same-route vehicle for the leg", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    vi.useFakeTimers();
    const l = leg({ agencyId: "LACMTA", routeId: "720-13201" });
    const p = metroBusFor(l);
    await vi.advanceTimersByTimeAsync(1);
    const ws = FakeWS.instances.at(-1)!;
    const near = {
      ...MSG,
      id: "near",
      vehicle: {
        ...MSG.vehicle,
        position: { latitude: 34.051, longitude: -118.251, bearing: 42 },
      },
    };
    const far = {
      ...MSG,
      id: "far",
      vehicle: {
        ...MSG.vehicle,
        position: { latitude: 34.5, longitude: -118.6 },
      },
    };
    const other = {
      ...MSG,
      id: "other",
      vehicle: { ...MSG.vehicle, trip: { routeId: "2-1" } },
    };
    ws.emit(far);
    ws.emit(near);
    ws.emit(other);
    await vi.advanceTimersByTimeAsync(2_600);
    const bus = await p;
    expect(bus).toEqual({ lat: 34.051, lon: -118.251, bearing: 42 });
  });

  it("returns null for non-Metro legs without opening a socket", async () => {
    vi.stubGlobal("WebSocket", FakeWS);
    FakeWS.instances = [];
    expect(await metroBusFor(leg({ agencyName: "OCTA" }))).toBeNull();
    expect(FakeWS.instances).toHaveLength(0);
  });
});
