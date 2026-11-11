import { useState } from "react";
import type { Place } from "./core";
import { gmapsEmbedUrl, gmapsUrl } from "./gmaps";

// External link + optional Embed-API preview. Panel/card chrome only — never
// inside the MapLibre canvas (Google terms).
export function GmapsLink({
  place,
  label = "View on Google Maps",
}: {
  place: Pick<Place, "name" | "address">;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const embed = gmapsEmbedUrl(place);
  return (
    <span className="gmaps-link">
      <a href={gmapsUrl(place)} target="_blank" rel="noreferrer">
        {label}
      </a>
      {embed && (
        <>
          {" · "}
          <button type="button" onClick={() => setOpen(true)}>
            Preview
          </button>
        </>
      )}
      {open && embed && (
        <div
          className="gmaps-overlay"
          role="dialog"
          aria-label={`${place.name} map preview`}
          onClick={() => setOpen(false)}
        >
          <div className="gmaps-frame" onClick={(e) => e.stopPropagation()}>
            <button
              className="gmaps-close"
              aria-label="Close preview"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <iframe title={place.name} src={embed} loading="lazy" />
          </div>
        </div>
      )}
    </span>
  );
}
