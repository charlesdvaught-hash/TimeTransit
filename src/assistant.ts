// STAGE-6: adventure-planner bridge to the relay's /llm "assist" task.
// Pure validation/mapping plus one network call; every failure path
// returns null so the chat panel degrades to a plain text reply.
import type { AdventurePlan } from "./contracts";
import type { Pin, TripChain } from "./core";
import { time } from "./display";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const POSITIONS = new Set(["first", "middle", "last"]);
const PREFIX: Record<string, string> = {
  first: "^",
  middle: "~",
  last: "$",
};

// Models without a clock hallucinate dates — drop parseable but
// already-past timestamps so they can't land in the departure control.
function fresh(iso: unknown): string | undefined {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return t > Date.now() - 15 * 60000 ? iso : undefined;
}

export function validateAdventure(
  v: unknown,
): { ok: true; result: AdventurePlan } | { ok: false; errors: string[] } {
  const o = v as AdventurePlan;
  if (!o || typeof o !== "object" || Array.isArray(o))
    return { ok: false, errors: ["response is not an object"] };
  const errors: string[] = [];
  const stops = o.stops;
  if (!Array.isArray(stops) || !stops.length || stops.length > 4)
    errors.push("stops must be an array of 1 to 4 entries");
  else
    stops.forEach((s, i) => {
      if (!s || typeof s !== "object")
        return errors.push(`stops[${i}] must be an object`);
      if (typeof s.query !== "string" || !s.query.trim())
        errors.push(`stops[${i}].query must be a non-empty string`);
      if (s.type !== "anchor" && s.type !== "category")
        errors.push(`stops[${i}].type must be "anchor" or "category"`);
      if (!Number.isFinite(s.dwell_min))
        errors.push(`stops[${i}].dwell_min must be a finite number`);
      if (s.position != null && !POSITIONS.has(s.position))
        errors.push(`stops[${i}].position must be first, middle, or last`);
    });
  if (typeof o.round_trip !== "boolean")
    errors.push("round_trip must be a boolean");
  for (const k of ["depart_at", "return_by", "notes"] as const)
    if (o[k] != null && typeof o[k] !== "string")
      errors.push(`${k} must be a string or null`);
  if (errors.length) return { ok: false, errors };
  // relay emits null for absent optionals — normalize to undefined
  return {
    ok: true,
    result: {
      stops: stops.map((s) => ({
        query: s.query.trim(),
        type: s.type,
        dwell_min: s.dwell_min,
        position: s.position ?? undefined,
      })),
      round_trip: o.round_trip,
      depart_at: fresh(o.depart_at),
      return_by: fresh(o.return_by),
      notes: o.notes ?? undefined,
    },
  };
}

export function applyAdventure(plan: AdventurePlan): {
  term: string;
  dwells: number[];
  pins: (Pin | undefined)[];
  back: boolean;
  departIso: string;
} {
  const d = plan.depart_at ? new Date(plan.depart_at) : null;
  // position prefixes only matter to the multi-stop optimizer; a single
  // segment goes through explore, which wouldn't strip them
  const multi = plan.stops.length > 1;
  return {
    term: plan.stops
      .map(
        (s) =>
          `${multi && s.position ? `${PREFIX[s.position]} ` : ""}${s.query}`,
      )
      .join(" + "),
    dwells: plan.stops.map((s) => s.dwell_min),
    pins: plan.stops.map((s) => s.position),
    back: plan.round_trip,
    departIso:
      d && Number.isFinite(d.getTime())
        ? new Date(d.getTime() - d.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : "",
  };
}

export function describeAdventure(plan: AdventurePlan): string {
  const parts = [plan.stops.map((s) => s.query).join(" → ")];
  if (plan.round_trip) parts.push("round trip");
  for (const [iso, label] of [
    [plan.depart_at, "leaving"],
    [plan.return_by, "back by"],
  ] as const) {
    const d = iso ? new Date(iso) : null;
    if (d && Number.isFinite(d.getTime())) parts.push(`${label} ${time(d)}`);
  }
  return parts.join(", ");
}

export function adventureGap(
  plan: AdventurePlan,
  chain: TripChain | null,
): string | null {
  if (!plan.return_by || !chain) return null;
  const target = new Date(plan.return_by).getTime();
  const end = Date.parse(
    chain.returnTrip?.endTime ?? chain.visits.at(-1)?.trip.endTime ?? "",
  );
  if (!Number.isFinite(target) || !Number.isFinite(end)) return null;
  const over = Math.round((end - target) / 60000);
  return over > 0
    ? `ends ${over} min after your ${time(new Date(target))} target`
    : null;
}

export async function adventureQuery(
  message: string,
  history: ChatMessage[] = [],
  signal?: AbortSignal,
): Promise<AdventurePlan | null> {
  const relay = import.meta.env.VITE_TRANSIT_RELAY;
  if (!relay) return null; // dev proxy can't serve /llm — degrade silently
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  let body: Record<string, unknown> = {
    task: "assist",
    input: `${message}\n(Current local time: ${local})`,
    history,
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
      const v = validateAdventure(await r.json());
      if (v.ok) return v.result;
      if (!attempt) body = { ...body, repair: { errors: v.errors } };
    } catch {
      return null;
    }
  }
  return null;
}
