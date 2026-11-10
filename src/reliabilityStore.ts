import { useSyncExternalStore } from "react";
import type { Itinerary } from "./core";
import {
  mergeObservations,
  observation,
  type Observation,
} from "./reliability";
import { readStored, writeStored } from "./storage";
function valid(value: unknown): value is Observation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (o) =>
        o &&
        typeof o.routeKey === "string" &&
        typeof o.tripId === "string" &&
        typeof o.stopId === "string" &&
        typeof o.routeName === "string" &&
        typeof o.stopName === "string" &&
        typeof o.agency === "string" &&
        typeof o.color === "string" &&
        Number.isFinite(o.delay) &&
        Number.isFinite(o.timestamp) &&
        Number.isFinite(Date.parse(o.scheduledTime)) &&
        Number.isFinite(Date.parse(o.actualTime)) &&
        (o.serviceDate === undefined ||
          (typeof o.serviceDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(o.serviceDate))) &&
        ["gps", "feed"].includes(o.source) &&
        ["departure", "arrival"].includes(o.event) &&
        typeof o.simulated === "boolean",
    )
  );
}
let records = readStored("timetransit.reliability", [] as Observation[], valid);
const listeners = new Set<() => void>();
const notify = () => {
  writeStored("timetransit.reliability", records);
  listeners.forEach((fn) => fn());
};
export function addObservations(items: (Observation | undefined)[]) {
  const incoming = items.filter((o): o is Observation => !!o);
  if (!incoming.length) return;
  records = mergeObservations(records, incoming);
  notify();
}
export function clearReliability() {
  records = [];
  notify();
}
export function logFeed(trips: Itinerary[]) {
  addObservations(
    trips.flatMap((t) =>
      t.legs
        .filter((l) => l.realTime && l.mode !== "WALK")
        .map((l) => observation(l, "feed", "departure", l.startTime)),
    ),
  );
}
export function useReliability() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => records,
    () => records,
  );
}
