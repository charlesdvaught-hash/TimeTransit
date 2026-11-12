// Continuous low-power position watch for the idle/browse state —
// the controller flips `active` on once geolocation permission is
// granted (boot-time permissions.query, or the "Use my location" tap).
// Battery-aware: coarse accuracy (the ride tracker keeps its own
// high-accuracy watch) and the watch clears while the tab is hidden.
import { useEffect, useRef, useState } from "react";
import type { UserPosition } from "./contracts";

export function useUserPosition(active: boolean): UserPosition | null {
  const [pos, setPos] = useState<UserPosition | null>(null);
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !navigator.geolocation) return;
    function start() {
      if (watchId.current != null) return;
      watchId.current = navigator.geolocation.watchPosition(
        (p) =>
          setPos({
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            accuracy: p.coords.accuracy,
            heading: p.coords.heading,
            speed: p.coords.speed,
            t: p.timestamp,
          }),
        () => {},
        { enableHighAccuracy: false, maximumAge: 5000, timeout: 15000 },
      );
    }
    function halt() {
      if (watchId.current != null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    }
    function onVis() {
      if (document.hidden) halt();
      else start();
    }
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      halt();
    };
  }, [active]);
  return pos;
}

// Safari lacks permissions.query for geolocation — treat any query
// failure as "not yet granted" so the opt-in tap remains the only gate.
export async function geolocationGranted(): Promise<boolean> {
  try {
    const r = await navigator.permissions?.query({
      name: "geolocation" as PermissionName,
    });
    return r?.state === "granted";
  } catch {
    return false;
  }
}
