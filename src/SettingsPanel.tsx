import { PreferencesPanel } from "./PreferencesPanel";
import { ReliabilityPanel } from "./ReliabilityPanel";
import type { AiMode } from "./contracts";
import { gmapsConfigured } from "./gmaps";
import type { TransitController } from "./useTimeTransit";
const tomtom = import.meta.env.VITE_TOMTOM_API_KEY || "";
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
