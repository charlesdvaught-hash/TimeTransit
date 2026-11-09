import { ArrowUpRight, Plus, X, Zap } from "lucide-react";
import { minutes, time } from "./display";
import { RouteChips } from "./RouteChips";
import type { TransitController } from "./useTimeTransit";
export function MultiStopPlanner({
  controller,
}: {
  controller: TransitController;
}) {
  const { busy, stops, setStops, back, setBack, chain, addStop, optimizeTrip } =
    controller;
  return (
    <div className="trip-builder">
      <h3>A few stops. One smart trip.</h3>
      <p>
        Mix specific places with “any” searches.
        <br />
        We’ll find the best order and places for you.
      </p>
      {stops.map((s, i) => (
        <div className="stop" key={s.id}>
          <span className="stop-index">{i + 1}</span>
          <div>
            <label>
              {s.candidates.length ? "SPECIFIC PLACE" : "ANY MATCHING PLACE"}
            </label>
            <input
              aria-label={`Stop ${i + 1}`}
              value={s.label}
              readOnly={!!s.candidates.length}
              onChange={(e) =>
                setStops(
                  stops.map((x) =>
                    x.id === s.id ? { ...x, label: e.target.value } : x,
                  ),
                )
              }
            />
            <label>
              Stay{" "}
              <input
                aria-label={`Dwell minutes ${i + 1}`}
                type="number"
                min="0"
                max="240"
                value={s.dwell}
                onChange={(e) =>
                  setStops(
                    stops.map((x) =>
                      x.id === s.id
                        ? {
                            ...x,
                            dwell: Math.max(0, Number(e.target.value)),
                          }
                        : x,
                    ),
                  )
                }
              />{" "}
              min
            </label>
          </div>
          <button
            title="Remove stop"
            onClick={() => setStops(stops.filter((x) => x.id !== s.id))}
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <button
        className="add-stop"
        disabled={stops.length >= 4}
        onClick={() => addStop()}
      >
        <Plus size={16} /> Add a stop <small>{stops.length}/4</small>
      </button>
      <label className="return">
        <input
          type="checkbox"
          checked={back}
          onChange={(e) => setBack(e.target.checked)}
        />{" "}
        Return to starting point
      </label>
      <button
        className="primary"
        disabled={busy || stops.length < 2}
        onClick={optimizeTrip}
      >
        <Zap size={17} />
        {busy ? "Comparing real journeys…" : "Find the smartest trip"}
        <ArrowUpRight size={18} />
      </button>
      <p className="fine">
        Top candidates → estimated combinations → up to 5 live-verified trips.
        Departure times include your dwell time.
      </p>
      {chain && (
        <div className="timeline">
          {chain.visits.map((v, i) => (
            <div key={v.stop.id}>
              <small>
                {time(v.trip.endTime)} · STOP {i + 1}
              </small>
              <h3>{v.place.name}</h3>
              <p>
                {minutes(v.trip.duration)} min travel · {v.stop.dwell} min stay
              </p>
              <RouteChips trip={v.trip} />
            </div>
          ))}
          {chain.returnTrip && (
            <div>
              <small>{time(chain.returnTrip.endTime)}</small>
              <h3>Back at your start</h3>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
