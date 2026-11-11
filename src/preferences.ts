import { chicago, type Itinerary, type Place } from "./core";
import { readStored, writeStored } from "./storage";
import type { AiMode } from "./contracts";
export type Preferences = {
  walkDistance: number;
  walkingSpeed: number;
  aiMode: AiMode;
  verifiedOnly: boolean;
  budgetOnly: boolean;
  theme: PaneTheme;
  paneAlpha: number;
};
export type PaneTheme = "ocean" | "ember" | "forest" | "dusk";
const THEMES: PaneTheme[] = ["ocean", "ember", "forest", "dusk"];
const AI_MODES: AiMode[] = ["none", "minimal", "full"];
export const defaults: Preferences = {
  walkDistance: 800,
  walkingSpeed: 1.4,
  aiMode: "minimal",
  verifiedOnly: false,
  budgetOnly: false,
  theme: "ocean",
  paneAlpha: 0.62,
};
export function validPreferences(value: unknown): value is Preferences {
  const p = value as Preferences | null;
  return (
    !!p &&
    Number.isFinite(p.walkDistance) &&
    p.walkDistance >= 200 &&
    p.walkDistance <= 2000 &&
    Number.isFinite(p.walkingSpeed) &&
    p.walkingSpeed >= 0.5 &&
    p.walkingSpeed <= 2
  );
}
export function loadPreferences(): Preferences {
  // STAGE-0: older saves lack the AI/filter fields — coerce, don't reject
  const p = readStored("timetransit.preferences", defaults, validPreferences);
  return {
    walkDistance: p.walkDistance,
    walkingSpeed: p.walkingSpeed,
    aiMode: AI_MODES.includes(p.aiMode) ? p.aiMode : defaults.aiMode,
    verifiedOnly: p.verifiedOnly === true,
    budgetOnly: p.budgetOnly === true,
    theme: THEMES.includes(p.theme) ? p.theme : defaults.theme,
    paneAlpha:
      Number.isFinite(p.paneAlpha) && p.paneAlpha >= 0.4 && p.paneAlpha <= 0.95
        ? p.paneAlpha
        : defaults.paneAlpha,
  };
}
export function applyTheme(p: Preferences) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = p.theme;
  document.documentElement.style.setProperty(
    "--pane-alpha",
    String(p.paneAlpha),
  );
}
export function savePreferences(p: Preferences) {
  writeStored("timetransit.preferences", p);
}
function validOrigin(p: unknown): p is Place {
  const v = p as Place | null;
  return (
    !!v &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    Number.isFinite(v.lat) &&
    Math.abs(v.lat) <= 90 &&
    Number.isFinite(v.lon) &&
    Math.abs(v.lon) <= 180
  );
}
export function loadOrigin() {
  return readStored("timetransit.origin", chicago, validOrigin);
}
export function hasSavedOrigin() {
  return (
    readStored<Place | null>(
      "timetransit.origin",
      null,
      (p): p is Place | null => validOrigin(p),
    ) !== null
  );
}
export function saveOrigin(p: Place) {
  writeStored("timetransit.origin", p);
}
export function walkParams(p: Preferences): Record<string, string> {
  const seconds = String(Math.floor(p.walkDistance / p.walkingSpeed));
  return {
    maxPreTransitTime: seconds,
    maxPostTransitTime: seconds,
    maxDirectTime: seconds,
    pedestrianSpeed: String(p.walkingSpeed),
    withDistance: "true",
  };
}
export function excessWalks(trip: Itinerary, p: Preferences) {
  return trip.legs.filter(
    (l) =>
      l.mode === "WALK" &&
      (l.distance ?? l.duration * p.walkingSpeed) > p.walkDistance,
  );
}
