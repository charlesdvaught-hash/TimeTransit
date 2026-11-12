// STAGE-1: semantic query parsing via the relay's /llm endpoint.
// Turns messy sentences into "anchor + category" terms; every failure
// path returns null so callers fall back to the raw term.
import { matchCategory } from "./core";
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
  const total =
    (Array.isArray(anchors) ? anchors.length : 0) +
    (Array.isArray(cats) ? cats.length : 0);
  if (!total)
    errors.push("high_priority_anchors and flexible_categories are both empty");
  else if (total > 4) errors.push("anchors + categories must total at most 4");
  return errors.length ? { ok: false, errors } : { ok: true, result: o };
}

export function toTerm(r: SemanticParseResult): string {
  return [
    ...r.high_priority_anchors.map((a) => a.normalized_entity_name),
    ...r.flexible_categories,
  ].join(" + ");
}

const session = new Map<string, SemanticParseResult>();

export async function parseQuery(
  term: string,
  signal?: AbortSignal,
): Promise<SemanticParseResult | null> {
  const relay = import.meta.env.VITE_TRANSIT_RELAY;
  if (!relay) return null; // dev proxy can't serve /llm — degrade silently
  const key = term.trim().toLowerCase();
  const hit = session.get(key);
  if (hit) return hit;
  let body: Record<string, unknown> = { task: "parse", input: term };
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
        body = { task: "parse", input: term, repair: { errors: v.errors } };
    } catch {
      return null;
    }
  }
  return null;
}
