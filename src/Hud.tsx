import { Navigation } from "lucide-react";
import { minutes, time } from "./display";
import type { TransitController } from "./useTimeTransit";
import { TripTracker } from "./TripTracker";

export function Hud({ controller }: { controller: TransitController }) {
  const { selected, trip, arrival, chain, total } = controller;
  const legs = chain
    ? [
        ...chain.visits.flatMap((v) => v.trip?.legs || []),
        ...(chain.returnTrip?.legs || []),
      ]
    : trip?.legs || [];
  if (!total) return null;
  return (
    <div className="hud">
      <div className="hud-symbol">
        <Navigation size={24} />
      </div>
      <div>
        <small>{chain ? "OPTIMIZED TRIP" : "FASTEST JOURNEY"}</small>
        <strong>
          {chain
            ? `${chain.visits.length} stops${chain.returnTrip ? " · round trip" : ""}`
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
            : arrival
              ? `Arrival ${time(arrival)}`
              : ""}
        </span>
      </div>
      <TripTracker
        legs={legs}
        onApply={chain ? undefined : controller.reroute}
        onBus={controller.setLiveBus}
      />
    </div>
  );
}
