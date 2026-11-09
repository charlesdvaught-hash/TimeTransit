import { type Itinerary } from "./core";
import { minutes, transfers } from "./display";
export function RouteChips({ trip }: { trip: Itinerary }) {
  const walk = trip.legs
    .filter((l) => l.mode === "WALK")
    .reduce((s, l) => s + l.duration, 0);
  return (
    <div className="route-chips">
      {trip.legs
        .filter((l) => l.mode !== "WALK")
        .map((l, i) => (
          <span
            key={i}
            style={{
              borderColor: `#${(l.routeColor || "339aff").replace("#", "")}`,
            }}
          >
            {l.routeShortName || l.mode}
          </span>
        ))}
      <small>
        {minutes(walk)} min walk · {transfers(trip.transfers)}
      </small>
    </div>
  );
}
