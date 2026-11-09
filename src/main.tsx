import { Navigation } from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import { createRoot } from "react-dom/client";
import { time } from "./display";
import { Hud } from "./Hud";
import { MapLayer } from "./MapLayer";
import { Panel } from "./Panel";
import "./style.css";
import { useTimeTransit } from "./useTimeTransit";
function App() {
  const controller = useTimeTransit();
  const { providers, now } = controller;
  return (
    <>
      <MapLayer controller={controller} />{" "}
      <header>
        <a className="brand" href="#">
          <span className="brand-icon">
            <Navigation size={19} />
          </span>
          Time<span>Transit</span>
          <small>BETA</small>
        </a>
        <div className="top-meta">
          <span className="live-dot" />
          {providers.length
            ? providers.slice(0, 2).join(" + ")
            : "Discovering local transit"}
          <span className="divider" />
          {time(now)}
        </div>
      </header>
      <Panel controller={controller} />
      <div className="map-label">
        <span className="live-dot" /> YOUR CITY. IN MINUTES.
      </div>
      <Hud controller={controller} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
