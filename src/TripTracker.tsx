import { useEffect, useRef, useState } from "react";
import type { Leg } from "./core";
import {
  transitLeg,
  simulationTrace,
  initialBoarding,
  updateBoarding,
} from "./boarding";
import { useTripTracking } from "./useTripTracking";
import { addObservations } from "./reliabilityStore";
import { observation } from "./reliability";
import { fetchTripDelays, fetchVehiclePositions } from "./gtfsrt";
import { liveVehicle } from "./transit";
import { loadScanIndex } from "./scanData";
import { inCoverage } from "./scan";
import { liveBusFor, watchJourney, type WatchdogResult } from "./watchdog";
import { time } from "./display";

function alertPing() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => ctx.close(), 500);
  } catch {
    /* audio blocked until user gesture */
  }
  navigator.vibrate?.([180, 80, 180]);
}

export function TripTracker({
  legs,
  onApply,
  onBus,
}: {
  legs: Leg[];
  onApply?: (from: { lat: number; lon: number }, at: number) => void;
  onBus?: (pos: { lat: number; lon: number } | null) => void;
}) {
  const tracking = useTripTracking(legs),
    [delay, setDelay] = useState(4),
    [index, setIndex] = useState(0),
    [message, setMessage] = useState(""),
    [notice, setNotice] = useState<WatchdogResult>(null),
    [busInfo, setBusInfo] = useState<{
      stopsAway?: number;
      eta?: number;
    } | null>(null),
    lastNotice = useRef("");
  const transit = legs.filter(transitLeg);

  // watchdog: while tracking, re-check the plan against realtime delays
  const w = tracking.watch;
  useEffect(() => {
    if (!tracking.active || !w?.fix) return;
    let alive = true;
    const tick = async () => {
      const index = await loadScanIndex().catch(() => undefined);
      if (!alive || !index || !inCoverage(index, w.fix)) return;
      const [delays, vehicles] = await Promise.all([
        fetchTripDelays().catch(() => undefined),
        fetchVehiclePositions().catch(() => undefined),
      ]);
      if (!alive) return;
      const leg = transit[w.legIndex];
      let bus =
        vehicles && leg
          ? liveBusFor(index, leg, vehicles, delays, Date.now())
          : null;
      // GTFS-RT has no match (non-OCTA leg or missing trip) — try
      // Transit's vehicle feed, which covers all agencies it serves.
      if (!bus && leg)
        bus = (await liveVehicle(leg).catch(() => undefined)) ?? null;
      onBus?.(bus);
      setBusInfo(bus);
      const r = watchJourney({
        index,
        legs,
        transitIndex: w.legIndex,
        phase: w.phase === "alighted" ? "waiting" : w.phase,
        position: { lat: w.fix.lat, lon: w.fix.lon },
        now: Date.now(),
        delays,
      });
      if (alive && r) {
        const key = `${r.kind}|${r.hint}`;
        if (key !== lastNotice.current) {
          lastNotice.current = key;
          alertPing();
        }
        setNotice(r);
      }
    };
    tick();
    const timer = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tracking.active, w?.phase, w?.legIndex]);
  useEffect(() => {
    if (!tracking.active) {
      setNotice(null);
      setBusInfo(null);
      lastNotice.current = "";
      onBus?.(null);
    }
  }, [tracking.active]); // eslint-disable-line react-hooks/exhaustive-deps
  const simulation =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("simulate") === "1";
  function seed() {
    try {
      const leg = transit[Math.min(index, transit.length - 1)];
      if (!leg) throw new Error("Select a simulation leg.");
      if (delay >= -1 && delay <= 5)
        throw new Error(
          "Choose earlier than −1 min or later than 5 min to demonstrate an unreliable flag. Four minutes late is on time by the configured threshold.",
        );
      for (let i = 0; i < 5; i++) {
        const demo = { ...leg, tripId: `demo-${leg.tripId}-${i}` };
        let state = initialBoarding();
        for (const fix of simulationTrace(demo, delay * 60))
          state = updateBoarding(state, fix, demo);
        if (!state.departure || state.phase !== "alighted")
          throw new Error("Synthetic trace could not establish a full ride.");
        addObservations([
          observation(
            demo,
            "gps",
            "departure",
            new Date(state.departure).toISOString(),
            true,
          ),
          observation(
            demo,
            "gps",
            "arrival",
            new Date(state.arrival!).toISOString(),
            true,
          ),
        ]);
      }
      setMessage(
        "Seeded 5 SIMULATED trips. Enable ‘Show simulated data only’ in Route reliability.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <div className="trip-tracker">
      <div>
        <button
          className="tracking-button"
          disabled={!transit.length || tracking.active}
          onClick={() => tracking.start()}
        >
          Start trip · GPS
        </button>
        {tracking.active && (
          <button onClick={tracking.stop}>Stop tracking</button>
        )}
      </div>
      <p className="tracking-status" role="status">
        {tracking.status ||
          (transit.length
            ? "Opt-in GPS boarding estimate · no location history saved"
            : "Select a bus or train journey to track boarding")}
      </p>
      {tracking.error && <p role="alert">{tracking.error}</p>}
      {busInfo?.eta && tracking.active && (
        <p className="bus-eta" role="status">
          Your bus
          {busInfo.stopsAway !== undefined && busInfo.stopsAway > 0
            ? ` is ${busInfo.stopsAway} stop${busInfo.stopsAway === 1 ? "" : "s"} away`
            : ""}{" "}
          · arrives ~{time(new Date(busInfo.eta))}
        </p>
      )}
      {notice && tracking.active && (
        <p className="reroute-notice" role="alert">
          {notice.kind === "better" ? (
            <>
              Faster now: {notice.hint} · arrive {time(new Date(notice.eta))} (−
              {notice.savesMin} min)
              {onApply && (
                <button
                  onClick={() => {
                    if (tracking.watch?.fix)
                      onApply(
                        {
                          lat: tracking.watch.fix.lat,
                          lon: tracking.watch.fix.lon,
                        },
                        Date.now(),
                      );
                    setNotice(null);
                  }}
                >
                  Switch route
                </button>
              )}
            </>
          ) : (
            <>
              Heads up: {notice.hint}
              {notice.eta
                ? ` · best fallback arrives ${time(new Date(notice.eta))}`
                : ""}
            </>
          )}
          <button aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
          <img
            className="notice-badge"
            src="transit-api-badge.svg"
            alt="Powered by Transit"
          />
        </p>
      )}
      {simulation && (
        <details className="simulation-controls">
          <summary>Simulation lab · synthetic data only</summary>
          <select
            aria-label="Simulation leg"
            value={Math.min(index, Math.max(0, transit.length - 1))}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {transit.map((l, i) => (
              <option key={i} value={i}>
                {l.agencyName} · {l.routeShortName || l.mode} · {l.from.name}
              </option>
            ))}
          </select>
          <label>
            Delay (minutes; negative = early)
            <input
              aria-label="Simulation delay"
              type="number"
              min="-30"
              max="60"
              value={delay}
              onChange={(e) =>
                setDelay(Math.max(-30, Math.min(60, Number(e.target.value))))
              }
            />
          </label>
          <button
            disabled={!transit.length || tracking.active}
            onClick={() =>
              tracking.start(true, delay, Math.min(index, transit.length - 1))
            }
          >
            Simulate ride
          </button>
          <button disabled={!transit.length} onClick={seed}>
            Seed 5 demo trips
          </button>
          <p>{message}</p>
        </details>
      )}
      <small>
        Estimates can mistake a nearby vehicle or parallel route. Keep this page
        open; GPS may pause in the background. No route can be identified from
        GPS alone.
      </small>
    </div>
  );
}
