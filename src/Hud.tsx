import { Navigation, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { minutes, time } from "./display";
import type { TransitController } from "./useTimeTransit";
import { TripTracker } from "./TripTracker";

export function Hud({ controller }: { controller: TransitController }) {
  const { selected, trip, arrival, chain, total, interpreted } = controller;
  // STAGE-1: the unified search box lives in ResultsList's .search-wrap;
  // portal the interpretation chip there so it sits under the input
  const [searchWrap, setSearchWrap] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSearchWrap(document.querySelector<HTMLElement>(".search-wrap"));
  }, []);
  const legs = chain
    ? [
        ...chain.visits.flatMap((v) => v.trip?.legs || []),
        ...(chain.returnTrip?.legs || []),
      ]
    : trip?.legs || [];
  return (
    <>
      {interpreted &&
        searchWrap &&
        createPortal(
          <p className="interpreted">
            <span>
              Interpreted as: <strong>{interpreted}</strong>
            </span>
            <button
              title="Dismiss interpretation"
              aria-label="Dismiss interpretation"
              onClick={() => controller.setInterpreted(null)}
            >
              <X size={12} />
            </button>
          </p>,
          searchWrap,
        )}
      {!!total && (
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
      )}
    </>
  );
}
