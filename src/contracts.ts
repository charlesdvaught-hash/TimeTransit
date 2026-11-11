// Shared cross-feature types. Pure types only — no logic.
export type AiMode = "none" | "minimal" | "full";
export type SemanticParseResult = {
  original_query: string;
  high_priority_anchors: {
    raw_term: string;
    normalized_entity_name: string;
  }[];
  flexible_categories: string[];
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
