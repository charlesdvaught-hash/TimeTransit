import type { Itinerary, Place, Stop } from "./core";

export function departureSnapshot(value: string, now = new Date()): Date {
  return value ? new Date(value) : now;
}

export async function resolveTripCandidates(
  stops: Stop[],
  find: (query: string) => Promise<Place[]>,
  route: (place: Place) => Promise<Itinerary>,
  signal?: AbortSignal,
): Promise<Stop[]> {
  const specificIds = new Set(
    stops.flatMap((stop) => stop.candidates.map((place) => place.id)),
  );
  const resolved: Stop[] = [];
  for (const stop of stops) {
    signal?.throwIfAborted();
    if (stop.candidates.length) {
      resolved.push(stop);
      continue;
    }
    const candidates = (await find(stop.label)).filter(
      (place) => !specificIds.has(place.id),
    );
    const timed: { place: Place; duration: number }[] = [];
    let lastError: unknown;
    for (const place of candidates.slice(0, 6)) {
      signal?.throwIfAborted();
      try {
        const trip = await route(place);
        signal?.throwIfAborted();
        timed.push({ place, duration: trip.duration });
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        lastError = error;
      }
    }
    if (!timed.length) {
      const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
      throw new Error(`No routable candidates for “${stop.label}”.${detail}`);
    }
    resolved.push({
      ...stop,
      candidates: timed
        .sort((a, b) => a.duration - b.duration)
        .map((candidate) => candidate.place),
    });
  }
  return resolved;
}
