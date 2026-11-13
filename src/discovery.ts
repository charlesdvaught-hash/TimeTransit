// LLM discovery: suggestPlaces proposes real place names (niche or
// outside the base search area); every name is geocode-verified through
// Photon before it may become a candidate — unverifiable or implausible
// names are dropped here, so hallucinations never reach the UI.
import { distance, type Place } from "./core";
import { geocode } from "./api";
import { suggestPlaces, type PlaceSuggestion } from "./semantic";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "at",
  "and",
  "for",
  "in",
  "on",
  "de",
  "la",
  "el",
]);

const tokens = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

// Does a geocoded result plausibly name the suggested place? Accent-folded
// token overlap — at least half the suggestion's significant tokens must
// appear in the found name ("Angels Flight" matches "Angels Flight
// Railway"; "Wurstküche" matches "Wurstkuche").
export function nameMatch(suggested: string, found: string): boolean {
  const a = tokens(suggested);
  if (!a.length) return false;
  const b = new Set(tokens(found));
  return (
    a.filter((t) => b.has(t)).length >= Math.max(1, Math.ceil(a.length / 2))
  );
}

// Geocode-verify one suggestion: Photon must return a same-named place
// within range. 120 km — outside the base area is the point; journey-time
// ranking downstream decides if it's actually reachable.
export async function verifySuggestion(
  s: PlaceSuggestion,
  origin: Place,
  signal?: AbortSignal,
  maxKm = 120,
): Promise<Place | null> {
  const hits = await geocode(
    `${s.name} ${s.area ?? ""}`.trim(),
    origin,
    signal,
  ).catch(() => []);
  const p = hits.find((h) => nameMatch(s.name, h.name));
  return p && distance(origin, p) <= maxKm ? p : null;
}

// Suggest → verify → real Places for the candidate pool. One LLM call +
// ≤6 Photon lookups; every failure path degrades to [] so discovery never
// stalls or blocks the search.
export async function discoverPlaces(
  input: string,
  context: string | undefined,
  origin: Place,
  signal?: AbortSignal,
): Promise<Place[]> {
  const sugs = await suggestPlaces(input, context, signal);
  if (!sugs?.length) return [];
  const verified = await Promise.all(
    sugs.map((s) => verifySuggestion(s, origin, signal)),
  );
  const seen = new Set<string>();
  return verified.filter((p): p is Place => {
    if (!p) return false;
    const k = p.id ?? `${p.name.toLowerCase()}|${p.lat}|${p.lon}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
