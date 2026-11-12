// Transfer risk stratification — spec §3. Static classification at plan
// time; the runtime DEGRADED transition happens in the watchdog/recalc,
// not here.
import type { TransferRiskProfile, TransferRiskTier } from "./contracts";
import type { TripChain } from "./core";

const SAME_SITE_HIGH = 8; // min
const WALK_HIGH = 10; // min
const SAME_SITE_MED = 10;
const WALK_MED = 12;
const LONG_RIDE = 30; // min — after this, a missed transfer costs a lot
const STALE_HIGH = 9; // min — stale feed auto-elevates buffers under this

export function classifyTransfer(opts: {
  bufferMin: number;
  requiresWalk: boolean;
  precedingRideMin: number;
  staleFeed?: boolean;
}): TransferRiskProfile {
  const { bufferMin, requiresWalk, precedingRideMin, staleFeed } = opts;
  let tier: TransferRiskTier;
  const high = requiresWalk
    ? bufferMin < WALK_HIGH
    : bufferMin < SAME_SITE_HIGH;
  const med = requiresWalk ? bufferMin < WALK_MED : bufferMin < SAME_SITE_MED;
  if (
    high ||
    (precedingRideMin >= LONG_RIDE && bufferMin < WALK_MED) ||
    (staleFeed && bufferMin < STALE_HIGH)
  )
    tier = "HIGH_RISK";
  else if (med) tier = "MEDIUM";
  else tier = "LOW";
  return {
    tier,
    scheduledBufferMinutes: Math.round(bufferMin * 10) / 10,
    isSameSite: !requiresWalk,
    requiresWalk,
    precedingRideMinutes: Math.round(precedingRideMin * 10) / 10,
    // adaptive cadence — tightened near HIGH_RISK transfers by the caller
    pollIntervalMs: tier === "HIGH_RISK" ? 15_000 : 60_000,
  };
}

// Tiers for each transfer in a planned chain: buffer = next boarding leg's
// scheduled departure minus arrival at the alight point. A WALK leg between
// two transit legs means the transfer isn't same-site.
export function transferTiers(
  chain: TripChain,
  opts: { staleFeed?: boolean } = {},
): TransferRiskProfile[] {
  const out: TransferRiskProfile[] = [];
  for (let i = 0; i + 1 < chain.visits.length; i++) {
    const a = chain.visits[i].trip,
      b = chain.visits[i + 1].trip;
    const ride = [...a.legs].reverse().find((l) => l.mode !== "WALK");
    const next = b.legs.find((l) => l.mode !== "WALK");
    if (!ride || !next) continue;
    const requiresWalk = b.legs
      .slice(0, b.legs.indexOf(next))
      .some((l) => l.mode === "WALK" && l.duration > 60);
    const bufferMin =
      (Date.parse(next.scheduledStartTime || next.startTime) -
        Date.parse(a.endTime)) /
      60000;
    if (!Number.isFinite(bufferMin)) continue;
    out.push(
      classifyTransfer({
        bufferMin,
        requiresWalk,
        precedingRideMin:
          ride.duration ||
          (Date.parse(ride.endTime) - Date.parse(ride.startTime)) / 60000,
        staleFeed: opts.staleFeed,
      }),
    );
  }
  return out;
}
