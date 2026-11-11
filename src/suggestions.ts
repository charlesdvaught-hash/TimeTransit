import { distance, type Place } from "./core";

export type Suggestion = {
  id: string;
  kind: "type" | "place";
  label: string;
  detail?: string;
  place?: Place;
};

const filler = new Set(["the", "of", "and", "at", "in", "on", "near", "by"]);

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !filler.has(word));
}

// bounded edit distance — returns <= cap or cap+1
const editDistance = (a: string, b: string, cap: number) => {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length];
};

// a query word counts as "close" on exact, prefix (>=3 chars), or small typo
const wordHit = (asked: string, found: string[]) =>
  found.some(
    (w) =>
      w === asked ||
      (asked.length >= 3 && w.startsWith(asked)) ||
      (w.length >= 3 && asked.startsWith(w)) ||
      editDistance(asked, w, asked.length >= 7 ? 2 : 1) <=
        (asked.length >= 7 ? 2 : 1),
  );

export function nameScore(query: string, name: string) {
  const asked = words(query);
  const found = words(name);
  if (!asked.length || !found.length) return 0;
  if (found.join(" ") === asked.join(" ")) return 1000 + found.length;
  const hits = asked.filter((word) => wordHit(word, found)).length;
  if (!hits) return 0;
  let score = (hits / asked.length) * 300;
  if (hits === asked.length) score += 100;
  if (found[0] === asked[0] || wordHit(asked[0], [found[0]])) score += 200;
  return score;
}

const same = (a: Place, b: Place) =>
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
  distance(a, b) < 0.2;

export function mergeSuggestions(query: string, ...lists: Place[][]) {
  const kept: Place[] = [];
  const merged: Suggestion[] = [];
  for (const place of lists.flat()) {
    if (kept.some((other) => same(other, place))) continue;
    kept.push(place);
    merged.push({
      id: `place-${place.id}`,
      kind: "place",
      label: place.name,
      detail:
        place.address || `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`,
      place,
    });
  }
  const scored = merged.map((suggestion) => ({
    suggestion,
    score: nameScore(query, suggestion.label),
  }));
  return scored
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.suggestion);
}
