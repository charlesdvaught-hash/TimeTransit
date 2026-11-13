// STAGE-1: semantic query parsing via the relay's /llm endpoint.
// Turns messy sentences into "anchor + category" terms; every failure
// path returns null so callers fall back to the raw term.
import { distance, matchCategory, type Place } from "./core";
import { inCoverage, type ScanIndex } from "./scan";
import { loadScanIndex } from "./scanData";
import type { AiMode, SemanticParseResult } from "./contracts";

// quota gate — only free-form sentences worth an LLM round-trip
export function shouldParse(term: string, mode: AiMode): boolean {
  if (mode === "none") return false;
  if (term.includes("+")) return false;
  if (term.trim().split(/\s+/).filter(Boolean).length < 2) return false;
  return matchCategory(term).length === 0;
}

export function validateParse(
  v: unknown,
): { ok: true; result: SemanticParseResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = v as SemanticParseResult;
  if (!o || typeof o !== "object" || Array.isArray(o))
    return { ok: false, errors: ["response is not an object"] };
  if (typeof o.original_query !== "string")
    errors.push("original_query must be a string");
  const anchors = o.high_priority_anchors;
  if (!Array.isArray(anchors))
    errors.push("high_priority_anchors must be an array");
  else
    anchors.forEach((a, i) => {
      if (
        !a ||
        typeof a !== "object" ||
        typeof a.raw_term !== "string" ||
        !a.raw_term.trim() ||
        typeof a.normalized_entity_name !== "string" ||
        !a.normalized_entity_name.trim()
      )
        errors.push(
          `high_priority_anchors[${i}] needs non-empty raw_term and normalized_entity_name strings`,
        );
    });
  const cats = o.flexible_categories;
  if (!Array.isArray(cats)) errors.push("flexible_categories must be an array");
  else
    cats.forEach((c, i) => {
      if (typeof c !== "string" || !c.trim())
        errors.push(`flexible_categories[${i}] must be a non-empty string`);
    });
  if (
    o.related_terms !== undefined &&
    (!Array.isArray(o.related_terms) ||
      o.related_terms.some((t) => typeof t !== "string"))
  )
    errors.push("related_terms must be an array of strings");
  const total =
    (Array.isArray(anchors) ? anchors.length : 0) +
    (Array.isArray(cats) ? cats.length : 0);
  if (!total)
    errors.push("high_priority_anchors and flexible_categories are both empty");
  else if (total > 4) errors.push("anchors + categories must total at most 4");
  const result = {
    ...o,
    related_terms: Array.isArray(o.related_terms)
      ? o.related_terms.filter((t) => typeof t === "string").slice(0, 4)
      : [],
    min_rating: typeof o.min_rating === "number" ? o.min_rating : null,
    max_price: typeof o.max_price === "number" ? o.max_price : null,
  };
  return errors.length ? { ok: false, errors } : { ok: true, result };
}

export function toTerm(r: SemanticParseResult): string {
  return [
    ...r.high_priority_anchors.map((a) => a.normalized_entity_name),
    ...r.flexible_categories,
  ].join(" + ");
}

// Trip context sent alongside /llm calls — a one-shot "where am I and
// what can I catch" block. Corridors come from the local scan index:
// patterns whose nearest stop is a short walk away, "route → headsign".
export function routeCorridors(
  index: ScanIndex,
  origin: Place,
  opts: { maxWalkM?: number; cap?: number } = {},
): { r: string; h: string }[] {
  const seen = new Set<string>();
  return index.patterns
    .map((p) => ({
      p,
      walk: Math.min(
        ...p.stops.map((si) => {
          const s = index.stops[si];
          return s
            ? distance(origin, { lat: s.la, lon: s.lo }) * 1000
            : Infinity;
        }),
      ),
    }))
    .filter((x) => x.walk <= (opts.maxWalkM ?? 1600))
    .sort((a, b) => a.walk - b.walk)
    .filter(({ p }) => {
      const k = `${p.r}|${p.h}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, opts.cap ?? 14)
    .map(({ p }) => ({ r: p.r, h: p.h }));
}

// One-shot context block for /llm calls: origin + local time + transit
// corridors reachable on foot. Outside scan coverage it's still useful —
// it always carries origin and time. Async because the index loads lazily.
export async function llmContext(origin: Place): Promise<string> {
  const lines = [
    `Origin: ${origin.name} (${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)})`,
    `Current local time: ${new Date().toISOString()}`,
  ];
  const index = await loadScanIndex().catch(() => undefined);
  if (index && inCoverage(index, origin)) {
    const cs = routeCorridors(index, origin);
    if (cs.length)
      lines.push(
        `Transit corridors near origin: ${cs.map((c) => `${c.r} → ${c.h}`).join("; ")}`,
      );
  }
  return lines.join("\n");
}

// STAGE-5b: intent ranking — the model judges which fetched candidates
// match the query's modifiers (name + venue kind only; never invents
// places). Returns ordered candidate indices, or null on any failure.
const rankSession = new Map<string, number[]>();
export async function rankPlaces(
  query: string,
  places: { name: string; kind?: string }[],
  context?: string,
  signal?: AbortSignal,
): Promise<number[] | null> {
  const relay = import.meta.env.VITE_TRANSIT_RELAY;
  if (!relay || !places.length) return null;
  const key =
    query.trim().toLowerCase() +
    "|" +
    places.map((p) => p.name.toLowerCase()).join("|");
  const hit = rankSession.get(key);
  if (hit) return hit;
  try {
    const r = await fetch(`${relay}/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(2500),
      ]),
      body: JSON.stringify({
        task: "rank",
        input: JSON.stringify({
          query,
          candidates: places.map((p) => ({
            name: p.name,
            kind: p.kind ?? null,
          })),
        }),
        ...(context ? { context } : {}),
      }),
    });
    if (!r.ok) return null;
    const o = await r.json();
    const idx = o?.ranked_indices;
    if (!Array.isArray(idx)) return null;
    const order = [
      ...new Set(
        idx.filter(
          (i): i is number =>
            Number.isInteger(i) && i >= 0 && i < places.length,
        ),
      ),
    ];
    if (order.length) rankSession.set(key, order);
    return order.length ? order : null;
  } catch {
    return null;
  }
}

const session = new Map<string, SemanticParseResult>();

export async function parseQuery(
  term: string,
  context?: string,
  signal?: AbortSignal,
): Promise<SemanticParseResult | null> {
  const relay = import.meta.env.VITE_TRANSIT_RELAY;
  if (!relay) return null; // dev proxy can't serve /llm — degrade silently
  const key = term.trim().toLowerCase();
  const hit = session.get(key);
  if (hit) return hit;
  let body: Record<string, unknown> = {
    task: "parse",
    input: term,
    ...(context ? { context } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${relay}/llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(2500),
        ]),
      });
      if (!r.ok) return null;
      const v = validateParse(await r.json());
      if (v.ok) {
        session.set(key, v.result);
        return v.result;
      }
      if (!attempt)
        body = {
          task: "parse",
          input: term,
          ...(context ? { context } : {}),
          repair: { errors: v.errors },
        };
    } catch {
      return null;
    }
  }
  return null;
}

export type PlaceSuggestion = { name: string; area?: string };

export function validateSuggest(v: unknown): PlaceSuggestion[] {
  const sugs = (v as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(sugs)) return [];
  return sugs
    .filter(
      (s): s is { name: string; area?: unknown } =>
        !!s &&
        typeof s === "object" &&
        typeof (s as { name?: unknown }).name === "string" &&
        (s as { name: string }).name.trim().length > 0 &&
        (s as { name: string }).name.length <= 100 &&
        ((s as { area?: unknown }).area === undefined ||
          (typeof (s as { area?: unknown }).area === "string" &&
            ((s as { area: string }).area as string).length <= 100)),
    )
    .map((s) => ({
      name: s.name.trim(),
      ...(typeof s.area === "string" && s.area.trim()
        ? { area: s.area.trim() }
        : {}),
    }))
    .slice(0, 6);
}

// LLM discovery: the model's world knowledge proposes niche/out-of-area
// places. Callers MUST geocode-verify results before showing them —
// see discovery.ts — the model can emit names that don't exist.
export async function suggestPlaces(
  input: string,
  context?: string,
  signal?: AbortSignal,
): Promise<PlaceSuggestion[] | null> {
  const relay = import.meta.env.VITE_TRANSIT_RELAY;
  if (!relay) return null;
  try {
    const r = await fetch(`${relay}/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(4000),
      ]),
      body: JSON.stringify({
        task: "suggest",
        input,
        ...(context ? { context } : {}),
      }),
    });
    if (!r.ok) return null;
    return validateSuggest(await r.json());
  } catch {
    return null;
  }
}
