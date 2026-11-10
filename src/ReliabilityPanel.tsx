import { useState } from "react";
import { clearReliability, useReliability } from "./reliabilityStore";
import { statistics, type Observation } from "./reliability";
import { storageWarning } from "./storage";
export function ReliabilityPanel() {
  const records = useReliability();
  const [demo, setDemo] = useState(false);
  const visible = records.filter((o) => o.simulated === demo);
  const routes = [...new Set(visible.map((o) => o.routeKey))];
  function summary(items: Observation[]) {
    const s = statistics(items);
    return (
      <>
        <b
          className={
            s.unreliable ? "reliability-badge danger" : "reliability-badge"
          }
        >
          {s.unreliable ? "Unreliable · " : ""}
          {s.flag}
        </b>
        <p>
          n={s.n} · median {Math.round(s.median / 60)} min · {s.early}% early ·{" "}
          {s.late}% late · {s.onTime}% on time
        </p>
      </>
    );
  }
  return (
    <details className="utility-panel reliability-panel">
      <summary>
        Route reliability <span>{records.length} observations</span>
      </summary>
      <p>
        Local departure estimates, not a service guarantee. GPS counts 3× feed.
        Flags need 5 distinct trip/stop samples. Early: &gt;1 min; late: &gt;5
        min.
      </p>
      <label>
        <input
          type="checkbox"
          checked={demo}
          onChange={(e) => setDemo(e.target.checked)}
        />{" "}
        Show simulated data only (excluded from real badges)
      </label>
      {!routes.length && (
        <p>
          No {demo ? "simulated" : "real"} observations yet. Search journeys for
          feed estimates or start a trip for GPS estimates.
        </p>
      )}
      {routes.map((key) => {
        const items = visible.filter((o) => o.routeKey === key),
          route = items[0];
        return (
          <section className="reliability-route" key={key}>
            <strong>
              {route.agency} · {route.routeName}
              {demo ? " · SIMULATED" : ""}
            </strong>
            {summary(items)}
            <details>
              <summary>
                Stops · {new Set(items.map((o) => o.stopId)).size}
              </summary>
              {[...new Set(items.map((o) => o.stopId))].map((id) => {
                const stops = items.filter((o) => o.stopId === id);
                return (
                  <div className="stop-stat" key={id}>
                    <strong>{stops[0].stopName}</strong>
                    {summary(stops)}
                    <small>
                      {stops.filter((o) => o.event === "arrival").length}{" "}
                      arrival observations (excluded from departure flags)
                    </small>
                  </div>
                );
              })}
            </details>
          </section>
        );
      })}
      <button
        className="add-stop"
        onClick={() => {
          if (
            window.confirm(
              "Clear all local reliability observations, including simulations?",
            )
          )
            clearReliability();
        }}
      >
        Clear reliability data
      </button>
      {storageWarning() && <p role="alert">{storageWarning()}</p>}
    </details>
  );
}
