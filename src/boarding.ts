import { decode, distance, type Leg } from "./core";
export type Fix = {
  lat: number;
  lon: number;
  t: number;
  accuracy: number;
  speed?: number | null;
};
export type BoardingState = {
  phase: "approaching" | "waiting" | "boarded" | "alighted";
  previous?: Fix;
  movingSince?: number;
  departure?: number;
  stoppedSince?: number;
  arrival?: number;
};
export const initialBoarding = (): BoardingState => ({ phase: "approaching" });
export function transitLeg(leg: Leg) {
  return !!leg.tripId && !["WALK", "BIKE", "CAR"].includes(leg.mode);
}
export function legPath(leg: Leg) {
  return leg.legGeometry?.points
    ? decode(leg.legGeometry.points, leg.legGeometry.precision ?? 6).map(
        ([lon, lat]) => ({ lat, lon }),
      )
    : [];
}
export function pathDistance(
  fix: { lat: number; lon: number },
  path: { lat: number; lon: number }[],
) {
  let best = Infinity;
  const scale = Math.cos((fix.lat * Math.PI) / 180);
  for (let i = 1; i < path.length; i++) {
    const a = {
      x: (path[i - 1].lon - fix.lon) * scale * 111320,
      y: (path[i - 1].lat - fix.lat) * 111320,
    };
    const b = {
      x: (path[i].lon - fix.lon) * scale * 111320,
      y: (path[i].lat - fix.lat) * 111320,
    };
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, -(a.x * dx + a.y * dy) / (dx * dx + dy * dy || 1)),
    );
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}
export function updateBoarding(
  state: BoardingState,
  fix: Fix,
  leg: Leg,
): BoardingState {
  if (
    state.phase === "alighted" ||
    !Number.isFinite(fix.t) ||
    !Number.isFinite(fix.lat) ||
    !Number.isFinite(fix.lon) ||
    !Number.isFinite(fix.accuracy) ||
    fix.accuracy < 0 ||
    fix.accuracy > 50 ||
    (state.previous && fix.t <= state.previous.t)
  )
    return state;
  const next = { ...state, previous: fix };
  const scheduled = Date.parse(
    (state.phase === "boarded"
      ? leg.scheduledEndTime
      : leg.scheduledStartTime) || "",
  );
  const inWindow =
    Number.isFinite(scheduled) &&
    fix.t >= scheduled - 15 * 60000 &&
    fix.t <= scheduled + 60 * 60000;
  if (!inWindow) {
    return state.phase === "boarded"
      ? { ...next, stoppedSince: undefined, arrival: undefined }
      : {
          ...next,
          phase: "waiting",
          movingSince: undefined,
          departure: undefined,
        };
  }
  const nearStart =
    distance(fix, leg.from) * 1000 <= 75 + Math.min(25, fix.accuracy);
  const nearExit =
    distance(fix, leg.to) * 1000 <= 75 + Math.min(25, fix.accuracy);
  const dt = state.previous ? (fix.t - state.previous.t) / 1000 : 0;
  const measured = dt > 0 ? (distance(fix, state.previous!) * 1000) / dt : 0;
  const speed = fix.speed == null ? measured : Math.min(fix.speed, measured);
  const off = pathDistance(fix, legPath(leg));
  if (state.phase === "approaching")
    return { ...next, phase: nearStart ? "waiting" : "approaching" };
  if (state.phase === "waiting") {
    if (
      nearStart ||
      speed <= 4 ||
      off > 60 + Math.min(20, fix.accuracy) ||
      dt > 60
    )
      return { ...next, movingSince: undefined, departure: undefined };
    const movingSince = state.movingSince ?? fix.t;
    return {
      ...next,
      movingSince,
      departure: movingSince,
      phase: fix.t - movingSince >= 20000 ? "boarded" : "waiting",
    };
  }
  const stopped =
    (nearExit && speed < 2) || (off > 90 + fix.accuracy && speed < 2.5);
  if (!stopped || dt > 60) return { ...next, stoppedSince: undefined };
  const stoppedSince = state.stoppedSince ?? fix.t;
  return {
    ...next,
    stoppedSince,
    phase: fix.t - stoppedSince >= 10000 ? "alighted" : "boarded",
    arrival: fix.t - stoppedSince >= 10000 ? stoppedSince : undefined,
  };
}

export function simulationTrace(leg: Leg, delaySeconds: number): Fix[] {
  const path = legPath(leg),
    lengths = [0];
  for (let i = 1; i < path.length; i++)
    lengths.push(lengths[i - 1] + distance(path[i - 1], path[i]) * 1000);
  const length = lengths.at(-1) || 0;
  if (length < 450 || !leg.scheduledStartTime || !leg.scheduledEndTime)
    throw new Error(
      "Simulation needs a scheduled leg with at least 450 m of route geometry.",
    );
  function pointAt(m: number) {
    const i = lengths.findIndex((v, i) => i > 0 && v >= m);
    if (i < 1) return path.at(-1)!;
    const f = (m - lengths[i - 1]) / (lengths[i] - lengths[i - 1] || 1);
    return {
      lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * f,
      lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * f,
    };
  }
  const start = Date.parse(leg.scheduledStartTime) + delaySeconds * 1000;
  const duration = Math.max(
    60,
    (Date.parse(leg.scheduledEndTime) - Date.parse(leg.scheduledStartTime)) /
      1000,
  );
  const make = (
    p: { lat: number; lon: number },
    t: number,
    speed: number,
  ): Fix => ({ ...p, t, accuracy: 5, speed });
  const fixes = [
    make(leg.from, start - 20000, 0),
    make(pointAt(115), start, 8),
    make(pointAt(215), start + 10000, 10),
    make(pointAt(315), start + 20000, 10),
  ];
  for (let t = 30; t < duration; t += 10)
    fixes.push(
      make(
        pointAt(315 + ((length - 315) * (t - 20)) / (duration - 20)),
        start + t * 1000,
        10,
      ),
    );
  fixes.push(
    make(leg.to, start + duration * 1000, 0),
    make(leg.to, start + (duration + 10) * 1000, 0),
  );
  return fixes;
}
