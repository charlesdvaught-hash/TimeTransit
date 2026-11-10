import { useEffect, useRef, useState } from "react";
import type { Leg } from "./core";
import {
  initialBoarding,
  simulationTrace,
  transitLeg,
  updateBoarding,
  type BoardingState,
  type Fix,
} from "./boarding";
import { observation } from "./reliability";
import { addObservations } from "./reliabilityStore";
import { time } from "./display";
export function useTripTracking(legs: Leg[]) {
  const [status, setStatus] = useState(""),
    [active, setActive] = useState(false),
    [error, setError] = useState("");
  const cleanup = useRef<(() => void) | null>(null);
  const signature = legs
    .filter(transitLeg)
    .map((l) => [l.tripId, l.from.stopId, l.to.stopId, l.startTime].join("/"))
    .join("|");
  function stop() {
    cleanup.current?.();
    cleanup.current = null;
    setActive(false);
  }
  useEffect(() => {
    stop();
    setStatus("");
    setError("");
    return () => cleanup.current?.();
  }, [signature]);
  function start(simulate = false, delayMinutes = 0, legIndex = 0) {
    stop();
    setError("");
    const transit = legs.filter(transitLeg);
    const sequence = simulate ? [transit[legIndex]] : transit;
    if (!sequence.length || !sequence[0]) {
      setError("Select a transit itinerary first.");
      return;
    }
    if (
      sequence.some(
        (l) =>
          !l.legGeometry?.points ||
          !l.scheduledStartTime ||
          !l.scheduledEndTime,
      )
    ) {
      setError(
        "This itinerary lacks geometry or scheduled times needed for detection.",
      );
      return;
    }
    let index = 0,
      state: BoardingState = initialBoarding();
    setActive(true);
    setStatus(
      `Approaching ${sequence[0].agencyName} ${sequence[0].routeShortName || sequence[0].mode}`,
    );
    function feed(fix: Fix) {
      const leg = sequence[index];
      if (!leg) return;
      const before = state.phase;
      state = updateBoarding(state, fix, leg);
      const prefix = simulate ? "SIMULATED · " : "";
      if (state.phase === "waiting")
        setStatus(
          `${prefix}Waiting for ${leg.agencyName} ${leg.routeShortName || leg.mode} · sched ${time(leg.scheduledStartTime!)}`,
        );
      if (state.phase === "boarded") {
        const delay = Math.round(
          (state.departure! - Date.parse(leg.scheduledStartTime!)) / 60000,
        );
        setStatus(
          `${prefix}On board · ${Math.abs(delay)} min ${delay < 0 ? "early" : delay > 0 ? "late" : "delay"} · ${leg.routeShortName || leg.mode}`,
        );
        if (before !== "boarded")
          addObservations([
            observation(
              leg,
              "gps",
              "departure",
              new Date(state.departure!).toISOString(),
              simulate,
            ),
          ]);
      }
      if (state.phase === "alighted") {
        addObservations([
          observation(
            leg,
            "gps",
            "arrival",
            new Date(state.arrival!).toISOString(),
            simulate,
          ),
        ]);
        index++;
        if (index === sequence.length) {
          setStatus(`${prefix}Arrived · ${leg.to.name}`);
          stop();
        } else {
          state = initialBoarding();
          setStatus(`Transfer · approach ${sequence[index].from.name}`);
        }
      }
    }
    if (simulate) {
      try {
        const trace = simulationTrace(sequence[0], delayMinutes * 60);
        let i = 0;
        const timer = window.setInterval(() => {
          if (i < trace.length) feed(trace[i++]);
          else {
            stop();
          }
        }, 250);
        cleanup.current = () => window.clearInterval(timer);
      } catch (e) {
        setError((e as Error).message);
        setActive(false);
      }
    } else if (!navigator.geolocation) {
      setError("GPS is unavailable in this browser.");
      setActive(false);
    } else {
      const id = navigator.geolocation.watchPosition(
        (p) =>
          feed({
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            t: p.timestamp,
            accuracy: p.coords.accuracy,
            speed: p.coords.speed,
          }),
        (e) => {
          setError(`GPS: ${e.message}`);
          stop();
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
      cleanup.current = () => navigator.geolocation.clearWatch(id);
    }
  }
  return { start, stop, status, active, error };
}
