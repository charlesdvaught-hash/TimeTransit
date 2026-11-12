// Shared cross-feature types. Pure types only — no logic.
export type AiMode = "none" | "minimal" | "full";
export type SemanticParseResult = {
  original_query: string;
  high_priority_anchors: {
    raw_term: string;
    normalized_entity_name: string;
  }[];
  flexible_categories: string[];
  related_terms: string[];
};
export type GooglePlaceDetail = {
  rating?: number;
  userRatingCount?: number;
  priceLevel?: 0 | 1 | 2 | 3 | 4;
  openNow?: boolean;
};
export type LocalEvent = {
  id: string;
  title: string;
  venue: string;
  lat: number;
  lon: number;
  start: string; // ISO local or UTC
  end?: string;
  url?: string;
  source: "seatgeek" | "lacity" | "santamonica" | "mobilizon";
  note?: string; // e.g. price hint, "Free", organizer
};
// Wave-0: saved places, recents, favorites, plan cache, GPS follow mode.
export type SavedPlace = {
  id: string;
  label: string;
  icon: "home" | "work" | "gym" | "pin";
  lat: number;
  lon: number;
  address?: string;
  updatedAt: number;
};
export type RecentSearch = {
  id: string;
  label: string;
  lat?: number;
  lon?: number;
  ts: number;
};
export type FavoriteLine = {
  routeId: string;
  agencyId?: string;
  shortName: string;
  color?: string;
};
export type CachedPlan = {
  savedAt: number;
  query: string;
  origin: { lat: number; lon: number; name: string };
  mode: "depart" | "arrive";
  targetTime?: number;
  results: unknown[];
  alerts?: unknown[];
};
export type GpsFollowMode = "free" | "center" | "heading";
export type UserPosition = {
  lat: number;
  lon: number;
  accuracy?: number;
  heading?: number | null;
  speed?: number | null;
  t: number;
};

export type AdventurePlan = {
  stops: {
    query: string;
    type: "anchor" | "category" | "event";
    dwell_min: number;
    position?: "first" | "middle" | "last";
  }[];
  round_trip: boolean;
  depart_at?: string;
  return_by?: string;
  notes?: string;
};
