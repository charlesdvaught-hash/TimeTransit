import { PreferencesPanel } from "./PreferencesPanel";
import { ReliabilityPanel } from "./ReliabilityPanel";
import type { AiMode } from "./contracts";
import type { TransitController } from "./useTimeTransit";
// STAGE-0: relay presence is the proxy for "Google Places key configured"
// (the key lives in the Worker env, never in the bundle).
const relay = import.meta.env.VITE_TRANSIT_RELAY || "";
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
            disabled={!relay}
            onChange={(e) =>
              setPreferences({ ...p, budgetOnly: e.target.checked })
            }
          />{" "}
          Budget friendly
          {!relay && <small> — Needs Google Places key</small>}
        </label>
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
