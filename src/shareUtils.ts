// Shareable journey links: ?to=&tolat=&tolon=&label=&fromlat=&fromlon=
// hydrate on boot. Web Share API with clipboard fallback.
import type { Place } from "./core";

export function shareUrl(origin: Place, dest: Place): string {
  const u = new URL(window.location.href);
  u.search = "";
  u.hash = "";
  const p = u.searchParams;
  p.set("to", dest.name);
  p.set("tolat", String(dest.lat));
  p.set("tolon", String(dest.lon));
  if (origin.id === "gps") {
    p.set("fromlat", String(origin.lat));
    p.set("fromlon", String(origin.lon));
  }
  return u.toString();
}

export async function shareJourney(
  origin: Place,
  dest: Place,
  summary: string,
): Promise<"shared" | "copied" | null> {
  const url = shareUrl(origin, dest);
  try {
    if (navigator.share) {
      await navigator.share({ title: "TimeTransit trip", text: summary, url });
      return "shared";
    }
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return null; // user dismissed the sheet, or clipboard denied
  }
}

// Boot hydration: {to,tolat,tolon,fromlat,fromlon} → a ready-to-run
// destination pin plus an optional origin override.
export function parseShareLink(): {
  dest?: Place;
  origin?: Place;
} | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  const tolat = Number(p.get("tolat")),
    tolon = Number(p.get("tolon")),
    name = p.get("to");
  const out: { dest?: Place; origin?: Place } = {};
  if (name && Number.isFinite(tolat) && Number.isFinite(tolon))
    out.dest = { id: "share-to", name, lat: tolat, lon: tolon };
  const flat = Number(p.get("fromlat")),
    flon = Number(p.get("fromlon"));
  if (Number.isFinite(flat) && Number.isFinite(flon))
    out.origin = {
      id: "share-from",
      name: "Shared start",
      lat: flat,
      lon: flon,
    };
  return out.dest || out.origin ? out : null;
}
