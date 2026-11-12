import type { Itinerary, Place, Stop } from "./core";

export function departureSnapshot(value: string, now = new Date()): Date {
  return value ? new Date(value) : now;
}

export async function resolveTripCandidates(
  stops: Stop[],
  find: (query: string) => Promise<Place[]>,
  route: (place: Place) => Promise<Pick<Itinerary, "duration">>,
  signal?: AbortSignal,
): Promise<Stop[]> {
  const specificIds = new Set(
    stops.flatMap((stop) =>
      [...stop.candidates, ...(stop.alternates ?? [])].map((place) => place.id),
    ),
  );
  // Stops and their candidates resolve independently — the fetch queue
  // bounds real concurrency, so Promise.all just keeps it saturated.
  const resolved = await Promise.all(
    stops.map(async (stop) => {
      signal?.throwIfAborted();
      if (stop.candidates.length) return stop;
      const candidates = (await find(stop.label)).filter(
        (place) => !specificIds.has(place.id),
      );
      signal?.throwIfAborted();
      let lastError: unknown;
      const timed = (
        await Promise.all(
          candidates.slice(0, 6).map(async (place) => {
            try {
              const trip = await route(place);
              return { place, duration: trip.duration };
            } catch (error) {
              signal?.throwIfAborted();
              if (error instanceof Error && error.name === "AbortError")
                throw error;
              lastError = error;
              return null;
            }
          }),
        )
      ).filter((t): t is { place: Place; duration: number } => t !== null);
      signal?.throwIfAborted();
      if (!timed.length) {
        const detail =
          lastError instanceof Error ? ` ${lastError.message}` : "";
        throw new Error(`No routable candidates for “${stop.label}”.${detail}`);
      }
      return {
        ...stop,
        pool: candidates.length,
        // candidates beyond the timed six stay available as swap/dropdown
        // options — routed on demand, never part of combo search
        alternates: candidates.slice(6, 20),
        candidates: timed
          .sort((a, b) => a.duration - b.duration)
          .map((candidate) => candidate.place),
      };
    }),
  );
  return resolved;
}
