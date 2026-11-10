import type { Leg } from "./core";
export type Observation = {
  routeKey: string;
  routeName: string;
  agency: string;
  color: string;
  stopId: string;
  stopName: string;
  tripId: string;
  scheduledTime: string;
  serviceDate?: string;
  actualTime: string;
  delay: number;
  source: "feed" | "gps";
  event: "departure" | "arrival";
  timestamp: number;
  simulated: boolean;
};
export function routeKey(leg: Leg) {
  return leg.agencyId && leg.routeId
    ? JSON.stringify([leg.agencyId, leg.routeId])
    : undefined;
}
export function scheduledDate(time: string, timeZone?: string) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(time));
      return ["year", "month", "day"]
        .map((type) => parts.find((p) => p.type === type)!.value)
        .join("-");
    } catch {
      /* Use the timestamp's own date if timezone metadata is unavailable. */
    }
  }
  return time.slice(0, 10);
}
export function observation(
  leg: Leg,
  source: Observation["source"],
  event: Observation["event"],
  actualTime: string,
  simulated = false,
  timestamp = Date.now(),
): Observation | undefined {
  const key = routeKey(leg),
    stop = event === "departure" ? leg.from : leg.to;
  const scheduledTime =
    event === "departure" ? leg.scheduledStartTime : leg.scheduledEndTime;
  if (
    !key ||
    !leg.tripId ||
    !stop.stopId ||
    !scheduledTime ||
    !Number.isFinite(Date.parse(actualTime)) ||
    !Number.isFinite(Date.parse(scheduledTime))
  )
    return;
  return {
    routeKey: key,
    routeName: leg.routeShortName || leg.mode,
    agency: leg.agencyName || leg.agencyId!,
    color: leg.routeColor || "339aff",
    stopId: stop.stopId,
    stopName: stop.name,
    tripId: leg.tripId,
    scheduledTime,
    serviceDate: scheduledDate(scheduledTime, stop.tz),
    actualTime,
    delay: (Date.parse(actualTime) - Date.parse(scheduledTime)) / 1000,
    source,
    event,
    timestamp,
    simulated,
  };
}
export function observationId(o: Observation) {
  return JSON.stringify([
    o.tripId,
    o.stopId,
    o.serviceDate || scheduledDate(o.scheduledTime),
    o.source,
    o.simulated,
  ]);
}
export function mergeObservations(old: Observation[], incoming: Observation[]) {
  const entries = new Map(
    old.map((o) => {
      const replacement =
        !o.serviceDate &&
        incoming.find(
          (item) =>
            item.tripId === o.tripId &&
            item.stopId === o.stopId &&
            item.source === o.source &&
            item.simulated === o.simulated &&
            Date.parse(item.scheduledTime) === Date.parse(o.scheduledTime),
        );
      const upgraded = replacement
        ? { ...o, serviceDate: replacement.serviceDate }
        : o;
      return [observationId(upgraded), upgraded];
    }),
  );
  for (const item of incoming) entries.set(observationId(item), item);
  return [...entries.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-10000);
}
export function statistics(observations: Observation[]) {
  const distinct = new Map<string, Observation>();
  for (const o of observations.filter((o) => o.event === "departure")) {
    const key = JSON.stringify([
      o.tripId,
      o.stopId,
      o.serviceDate || scheduledDate(o.scheduledTime),
    ]);
    if (!distinct.has(key) || o.source === "gps") distinct.set(key, o);
  }
  const samples = [...distinct.values()].sort((a, b) => a.delay - b.delay);
  const weight = (o: Observation) => (o.source === "gps" ? 3 : 1);
  const total = samples.reduce((s, o) => s + weight(o), 0);
  let cumulative = 0,
    median = 0;
  for (let i = 0; i < samples.length; i++) {
    const o = samples[i];
    cumulative += weight(o);
    if (cumulative >= total / 2) {
      median =
        cumulative === total / 2 && samples[i + 1]
          ? (o.delay + samples[i + 1].delay) / 2
          : o.delay;
      break;
    }
  }
  const percent = (match: (o: Observation) => boolean) =>
    total
      ? Math.round(
          (100 * samples.filter(match).reduce((s, o) => s + weight(o), 0)) /
            total,
        )
      : 0;
  const early = percent((o) => o.delay < -60),
    late = percent((o) => o.delay > 300);
  const onTime = percent((o) => o.delay >= -60 && o.delay <= 300);
  const unreliable =
    samples.length >= 5 && (onTime < 70 || median < -60 || median > 300);
  const flag =
    samples.length < 5
      ? "Learning"
      : !unreliable
        ? "On time"
        : median < -60 || early > late
          ? "Runs early"
          : "Often late";
  return { n: samples.length, median, early, late, onTime, unreliable, flag };
}
