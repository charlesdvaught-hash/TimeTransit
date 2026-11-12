import { PreferencesPanel } from "./PreferencesPanel";
import { ReliabilityPanel } from "./ReliabilityPanel";
import type { AiMode, SavedPlace } from "./contracts";
import { Briefcase, Dumbbell, Home, MapPin, Trash2 } from "lucide-react";
import { gmapsConfigured } from "./gmaps";
import type { Preferences } from "./preferences";
import type { TransitController } from "./useTimeTransit";
const tomtom = import.meta.env.VITE_TOMTOM_API_KEY || "";
const SLOTS: { icon: SavedPlace["icon"]; name: string }[] = [
  { icon: "home", name: "Home" },
  { icon: "work", name: "Work" },
  { icon: "gym", name: "Gym" },
  { icon: "pin", name: "Custom place" },
];
const slotIcons = { home: Home, work: Briefcase, gym: Dumbbell, pin: MapPin };
const MODES: { id: AiMode; label: string; hint: string }[] = [
  { id: "none", label: "None", hint: "No AI features — current behavior" },
  { id: "minimal", label: "Minimal", hint: "Smart search only" },
  { id: "full", label: "Full", hint: "Smart search + adventure planner" },
];
export function SettingsPanel({
  controller,
}: {
  controller: TransitController;
}) {
  const { preferences: p, setPreferences } = controller;
  return (
    <details className="utility-panel settings-panel">
      <summary>
        Settings{" "}
        <span>{p.aiMode === "none" ? "AI off" : `AI: ${p.aiMode}`}</span>
      </summary>
      <details className="utility-panel">
        <summary>
          AI assistance <span>{p.aiMode}</span>
        </summary>
        {MODES.map((m) => (
          <label key={m.id}>
            <input
              type="radio"
              name="ai-mode"
              checked={p.aiMode === m.id}
              onChange={() => setPreferences({ ...p, aiMode: m.id })}
            />{" "}
            {m.label} — {m.hint}
          </label>
        ))}
      </details>
      <details className="utility-panel">
        <summary>Results filters</summary>
        <label>
          <input
            type="checkbox"
            checked={p.verifiedOnly}
            onChange={(e) =>
              setPreferences({ ...p, verifiedOnly: e.target.checked })
            }
          />{" "}
          Verified places only
        </label>
        <label>
          <input
            type="checkbox"
            checked={p.budgetOnly}
            disabled={!gmapsConfigured()}
            onChange={(e) =>
              setPreferences({ ...p, budgetOnly: e.target.checked })
            }
          />{" "}
          Budget friendly
          {!gmapsConfigured() && (
            <small> — needs a Google Places key on the relay</small>
          )}
        </label>
        <small className="settings-hint">
          Ratings &amp; price levels populate from Google when available — shown
          on a place once selected; Budget dims pricey places as details arrive.
        </small>
      </details>
      <details className="utility-panel">
        <summary>
          Appearance <span>{p.theme}</span>
        </summary>
        <label>
          Color theme{" "}
          <select
            value={p.theme}
            onChange={(e) =>
              setPreferences({
                ...p,
                theme: e.target.value as Preferences["theme"],
              })
            }
          >
            <option value="ocean">Ocean</option>
            <option value="ember">Ember</option>
            <option value="forest">Forest</option>
            <option value="dusk">Dusk</option>
          </select>
        </label>
        <label>
          Pane opacity: <strong>{Math.round(p.paneAlpha * 100)}%</strong>
          <input
            type="range"
            min="40"
            max="95"
            step="5"
            value={Math.round(p.paneAlpha * 100)}
            onChange={(e) =>
              setPreferences({ ...p, paneAlpha: Number(e.target.value) / 100 })
            }
          />
        </label>
        <small className="settings-hint">
          Lower values let more of the map show through (frosted glass).
        </small>
      </details>
      <details className="utility-panel">
        <summary>
          Saved places <span>{controller.bookmarks.length}/4</span>
        </summary>
        {SLOTS.map(({ icon, name }) => {
          const Icon = slotIcons[icon];
          const saved = controller.bookmarks.find((b) => b.icon === icon);
          return (
            <div className="saved-place" key={icon}>
              <Icon size={14} />
              {saved ? (
                <>
                  <input
                    aria-label={`${name} label`}
                    defaultValue={saved.label}
                    onBlur={(e) =>
                      controller.renameBookmark(saved.id, e.target.value)
                    }
                  />
                  <button
                    title={`Remove ${name}`}
                    aria-label={`Remove ${name}`}
                    onClick={() => controller.removeBookmark(saved.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              ) : (
                <button
                  className="saved-place-set"
                  onClick={() =>
                    controller.upsertBookmark(icon, controller.origin)
                  }
                >
                  Save current start as {name}
                </button>
              )}
            </div>
          );
        })}
        <small className="settings-hint">
          Saved places show live ETAs on the home board — set your start first
          (search, map pick, or GPS), then save it here.
        </small>
      </details>
      <PreferencesPanel controller={controller} />
      <ReliabilityPanel />
      <details className="utility-panel">
        <summary>Credits & data sources</summary>
        <p>
          Overture Maps (CC-BY) · OpenStreetMap contributors
          {tomtom ? " · TomTom" : ""} · Esri World Imagery · CARTO · Transit App
          API · Groq / Google Gemini AI
        </p>
        <p>
          <span className="live-dot" /> Powered by local transit
        </p>
      </details>
    </details>
  );
}
