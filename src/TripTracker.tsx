import { useState } from "react";
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
export function TripTracker({ legs }: { legs: Leg[] }) {
  const tracking = useTripTracking(legs),
    [delay, setDelay] = useState(4),
    [index, setIndex] = useState(0),
    [message, setMessage] = useState("");
  const transit = legs.filter(transitLeg);
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
