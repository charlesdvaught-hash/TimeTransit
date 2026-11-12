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
      <MapLayer
        controller={controller}
        userPosition={controller.userPosition}
        ridingView={controller.gpsOn && !!controller.trip}
      />
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
          <span className="provider-name" title={providers.join(" + ")}>
            {providers.length
              ? providers.join(" + ")
              : "Discovering local transit"}
          </span>
          <span className="divider" />
          <span className="status-clock">{time(now)}</span>
        </div>
      </header>
      <Panel controller={controller} />
      <Hud controller={controller} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
