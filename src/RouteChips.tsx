import { type Itinerary } from "./core";
import { minutes, transfers } from "./display";
import { routeKey, statistics } from "./reliability";
import { useReliability } from "./reliabilityStore";
import { excessWalks, type Preferences } from "./preferences";
export function RouteChips({
  trip,
  preferences,
}: {
  trip: Itinerary;
  preferences?: Preferences;
}) {
  const observations = useReliability();
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
            {(() => {
              const stats = statistics(
                observations.filter(
                  (o) => !o.simulated && o.routeKey === routeKey(l),
                ),
              );
              return (
                <small
                  className={
                    stats.unreliable
                      ? "reliability-badge danger"
                      : "reliability-badge"
                  }
                >
                  {stats.unreliable ? "Unreliable · " : ""}
                  {stats.flag}
                </small>
              );
            })()}
          </span>
        ))}
      <small>
        {minutes(walk)} min walk · {transfers(trip.transfers)}
      </small>
      {preferences && excessWalks(trip, preferences).length > 0 && (
        <small className="walk-warning">
          Walk exceeds {preferences.walkDistance} m limit
        </small>
      )}
    </div>
  );
}
