import { Navigation } from "lucide-react";
import { minutes, time } from "./display";
import type { TransitController } from "./useTimeTransit";

export function Hud({ controller }: { controller: TransitController }) {
  const { selected, back, chain, total } = controller;
  return (
    <>
      {" "}
      {total ? (
        <div className="hud">
          <div className="hud-symbol">
            <Navigation size={24} />
          </div>
          <div>
            <small>{chain ? "OPTIMIZED TRIP" : "FASTEST JOURNEY"}</small>
            <strong>
              {chain
                ? `${chain.visits.length} stops${back ? " · round trip" : ""}`
                : selected?.place.name}
            </strong>
          </div>
          <div className="hud-time">
            <strong>
              {minutes(total)}
              <small> min</small>
            </strong>
            <span>
              {chain
                ? "Travel + time at stops"
                : `Arrival ${time(selected!.trip.endTime)}`}
            </span>
          </div>
        </div>
      ) : (
        <div className="map-tip">
          <Navigation size={15} /> The closest place isn’t always the quickest.
        </div>
      )}
    </>
  );
}
