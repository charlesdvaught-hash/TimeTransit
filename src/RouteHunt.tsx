import { useEffect, useState } from "react";
const TRACK = "M8 34 C 50 34, 60 12, 110 12 S 170 32, 212 32";
const NODES: [number, number][] = [
  [8, 34],
  [56, 23],
  [110, 12],
  [164, 22],
  [212, 32],
];
const EXPLORE_STEPS = [
  "Scanning the local network",
  "Walking to boarding stops",
  "Riding candidate trips",
  "Ranking by real arrival",
];
const COMPARE_STEPS = [
  "Comparing candidate journeys",
  "Checking transfer timing",
  "Optimizing stop order",
  "Ranking by arrival",
];
export function RouteHunt({
  compare,
  progress,
}: {
  compare: boolean;
  progress: number[];
}) {
  const steps = compare ? COMPARE_STEPS : EXPLORE_STEPS;
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => s + 1), 1900);
    return () => clearInterval(t);
  }, []);
  const msg = steps[step % steps.length];
  return (
    <div className="route-hunt" role="status" aria-live="polite">
      <svg className="hunt-path" viewBox="0 0 220 44" aria-hidden="true">
        <path className="hunt-track" d={TRACK} fill="none" />
        <path className="hunt-flow" d={TRACK} fill="none" />
        {NODES.map(([x, y], i) => (
          <circle
            key={x}
            className="hunt-node"
            cx={x}
            cy={y}
            r="3.4"
            style={{ animationDelay: `${i * 0.42}s` }}
          />
        ))}
        <circle className="hunt-pulse" r="4">
          <animateMotion dur="1.7s" repeatCount="indefinite" path={TRACK} />
        </circle>
      </svg>
      <div className="hunt-status">
        <span className="hunt-msg" key={msg}>
          {msg}
        </span>
        <span className="hunt-count">
          {progress[1] ? `${progress[0]}/${progress[1]}` : "…"}
        </span>
      </div>
      <div className="progress">
        <i
          style={{
            width: `${progress[1] ? (progress[0] / progress[1]) * 100 : 10}%`,
          }}
        />
      </div>
    </div>
  );
}
