import type { TransitController } from "./useTimeTransit";
import { storageWarning } from "./storage";
export function PreferencesPanel({
  controller,
}: {
  controller: TransitController;
}) {
  const { preferences: p, setPreferences } = controller;
  return (
    <details className="utility-panel">
      <summary>
        Walking preferences <span>{p.walkDistance} m</span>
      </summary>
      <label>
        Acceptable walk per leg: <strong>{p.walkDistance} m</strong>
        <input
          aria-label="Acceptable walk distance"
          type="range"
          min="200"
          max="2000"
          step="100"
          value={p.walkDistance}
          onChange={(e) =>
            setPreferences({ ...p, walkDistance: Number(e.target.value) })
          }
        />
      </label>
      <label>
        Walking speed{" "}
        <select
          aria-label="Walking speed"
          value={p.walkingSpeed}
          onChange={(e) =>
            setPreferences({ ...p, walkingSpeed: Number(e.target.value) })
          }
        >
          <option value="0.8">Easy · 0.8 m/s</option>
          <option value="1.1">Relaxed · 1.1 m/s</option>
          <option value="1.4">Typical · 1.4 m/s</option>
          <option value="1.8">Brisk · 1.8 m/s</option>
        </select>
      </label>
      <p>
        Changes clear journeys. Search again to use these limits. Transfer walks
        exceeding the limit are flagged.
      </p>
      {storageWarning() && <p role="alert">{storageWarning()}</p>}
    </details>
  );
}
