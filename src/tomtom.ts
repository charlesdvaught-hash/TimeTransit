import { distance, type Place } from "./core";

const key = (
  (import.meta.env.VITE_TOMTOM_API_KEY as string | undefined) ?? ""
).trim();
const cache = new Map<string, Place[]>();
let available = key.length > 0;

export function tomtomEnabled() {
  return available;
}

export async function tomtomSuggest(
  query: string,
  origin: Place,
  signal?: AbortSignal,
): Promise<Place[]> {
  const q = query.trim();
  if (!available || q.length < 3) return [];
  const cacheKey = `${q.toLowerCase()}|${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const params = new URLSearchParams({
    key,
    lat: String(origin.lat),
    lon: String(origin.lon),
    limit: "6",
    countrySet: "US",
    typeahead: "true",
    language: "en-US",
  });
  try {
    const response = await fetch(
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json?${params}`,
      { signal },
    );
    if ([401, 403, 429].includes(response.status)) {
      available = false;
      return [];
    }
    if (!response.ok) return [];
    const data = await response.json();
    const places = (Array.isArray(data?.results) ? data.results : []).flatMap(
      (result: any): Place[] => {
        const lat = result?.position?.lat;
        const lon = result?.position?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        const address = result?.address ?? {};
        const street = [address.streetNumber, address.streetName]
          .filter(Boolean)
          .join(" ");
        const name =
          result?.poi?.name || street || address.freeformAddress || q;
        const local = [address.municipality, address.countrySubdivision]
          .filter(Boolean)
          .join(", ");
        const detail =
          address.freeformAddress && address.freeformAddress !== name
            ? address.freeformAddress
            : local;
        const place: Place = {
          id: `tomtom-${result.id ?? `${lat},${lon}`}`,
          name,
          lat,
          lon,
          ...(detail ? { address: detail } : {}),
        };
        return distance(origin, place) <= 50 ? [place] : [];
      },
    );
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, places);
    return places;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return [];
  }
}
