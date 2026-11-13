// Ambient live vehicles on the map: the whole OCTA fleet (one ~30KB keyless
// GTFS-RT poll), all Metro rail (6 route codes), plus Metro buses on the
// current trip's routes — the Metro ws is route-filtered, so a fleet-wide
// stream (~20k msgs/12s) stays off the wire. Polls every 30 s; skips while
// the tab is hidden.
import { useEffect, useState } from "react";
import type { Leg } from "./core";
import { fetchVehiclePositions } from "./gtfsrt";
import { trySource } from "./liveSource";
import {
  METRO_RAIL_CODES,
  metroRouteFor,
  metroVehicles,
  type MetroAgency,
  type MetroVehicle,
} from "./metro";

export type VehicleDot = {
  lat: number;
  lon: number;
  bearing?: number;
  agency: "octa" | "metro";
  route?: string;
};

const dot = (v: MetroVehicle): VehicleDot => ({
  lat: v.lat,
  lon: v.lon,
  bearing: v.bearing,
  agency: "metro",
  route: v.routeCode,
});

export function useVehicles(legs: (Leg | undefined)[]): VehicleDot[] {
  const [dots, setDots] = useState<VehicleDot[]>([]);
  const codesKey = [
    ...new Set(
      legs
        .map((l) => (l ? metroRouteFor(l) : null))
        .filter(
          (r): r is { agency: MetroAgency; code: string } =>
            r?.agency === "LACMTA",
        )
        .map((r) => r.code),
    ),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    let alive = true;
    const busCodes = codesKey ? codesKey.split(",") : [];
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const [octa, rail, bus] = await Promise.all([
        trySource("octa-rt", () => fetchVehiclePositions(), {
          timeoutMs: 6_000,
        }),
        trySource(
          "metro-rt",
          () => metroVehicles("LACMTA_Rail", METRO_RAIL_CODES),
          { timeoutMs: 11_000 },
        ),
        busCodes.length
          ? trySource("metro-rt", () => metroVehicles("LACMTA", busCodes), {
              timeoutMs: 11_000,
            })
          : undefined,
      ]);
      const out: VehicleDot[] = [];
      for (const v of octa?.values() ?? [])
        out.push({
          lat: v.lat,
          lon: v.lon,
          bearing: v.bearing,
          agency: "octa",
        });
      for (const v of rail ?? []) out.push(dot(v));
      for (const v of bus ?? []) out.push(dot(v));
      if (alive) setDots(out);
    };
    void tick();
    const t = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [codesKey]);
  return dots;
}
