import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import "./RouteBoard.css";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface BoardRoute {
  id: string;
  /** Line badge, up to 3 chars, e.g. "43", "543" */
  line: string;
  /** Every stop on the route, in trip order */
  stops: string[];
  /** Door-to-door minutes */
  minutes: number;
  /** Index in `stops` of the keystone. Default 0 (first stop). */
  keystone?: number;
}

export interface RouteBoardProps {
  routes: BoardRoute[];
  searching: boolean;
  /** [done, total]. total <= 0 means unknown. */
  progress: number[];
  /** Multi-stop mode: swaps the status words. */
  compare: boolean;
  /** Words to sift while searching, e.g. real nearby stop names. */
  flavor?: string[];
  /** Max rows. Default 10 wide, 8 narrow. */
  maxRows?: number;
  /** Tap on a keystone or a side stop. */
  onSelect?: (routeId: string, stop: string) => void;
}

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/·…->&'.,+";
const CW = 8; // px per flap cell (7px + 1px gap) — keep in sync with CSS
const GAP = 6;
const STEP_MS = 1900;
const SIFT_MS = 650;
const SIDE_MS = 2600;
const BADGE_CELLS = 3;
const TIME_CELLS = 3;

const SINGLE = [
  "Scanning the local network",
  "Walking to boarding stops",
  "Riding candidate trips",
  "Ranking by real arrival",
];
const MULTI = [
  "Comparing candidate journeys",
  "Checking transfer timing",
  "Optimizing stop order",
  "Ranking by arrival",
];
const SINGLE_S = [
  "Scanning network",
  "Walking to stops",
  "Riding trips",
  "Ranking arrivals",
];
const MULTI_S = [
  "Comparing trips",
  "Transfer times",
  "Ordering stops",
  "Ranking arrivals",
];

const DEFAULT_FLAVOR = [
  "Transfer",
  "Boarding",
  "Checking times",
  "Next bus",
  "On time",
  "Walking",
  "Waiting",
  "Riding",
];
const PHRASES = [
  "Walk 4 min",
  "Wait 6 min",
  "Ride 18 min",
  "Transfer",
  "Boarding",
  "Checking times",
  "Next bus 7 min",
  "On time",
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const prefersReduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Upper-case, strip accents, drop chars the drum lacks, fit to n cells. */
function fit(text: string, n: number): string {
  let s = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split("")
    .map((c) => (DRUM.includes(c) ? c : " "))
    .join("");
  if (s.length > n) s = s.slice(0, Math.max(0, n - 1)) + "…";
  return s.padEnd(n, " ");
}

const rightPad = (s: string, n: number) => s.slice(-n).padStart(n, " ");

/* ------------------------------------------------------------------ */
/* one flap cell + one field of cells                                  */
/* ------------------------------------------------------------------ */

const Cell = memo(
  function Cell() {
    return (
      <span className="rb-c">
        <span className="rb-h rb-tp">
          <i />
        </span>
        <span className="rb-h rb-bt">
          <i />
        </span>
        <span className="rb-h rb-f1">
          <i />
        </span>
        <span className="rb-h rb-f2">
          <i />
        </span>
      </span>
    );
  },
  () => true,
);

function paint(
  cell: HTMLElement,
  prev: string,
  next: string,
  animate: boolean,
) {
  const [tp, bt, f1, f2] = Array.from(cell.children) as HTMLElement[];
  const put = (h: HTMLElement, c: string) => {
    (h.firstChild as HTMLElement).textContent = c === " " ? "" : c;
  };
  put(tp, next);
  put(f2, next);
  put(bt, animate ? prev : next);
  put(f1, animate ? prev : next);
  if (animate) {
    f1.classList.remove("go");
    f2.classList.remove("go");
    void cell.offsetWidth; // restart animation
    f1.classList.add("go");
    f2.classList.add("go");
  }
}

interface FlapFieldProps {
  text: string;
  cells: number;
  delay?: number;
}

export const FlapField = memo(function FlapField({
  text,
  cells,
  delay = 0,
}: FlapFieldProps) {
  const root = useRef<HTMLSpanElement>(null);
  const state = useRef<{ v: string }[]>([]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (state.current.length > cells) state.current.length = cells;
    const target = fit(text, cells);
    const animate = !prefersReduced();
    const timers: number[] = [];

    for (let i = 0; i < cells; i++) {
      const s = (state.current[i] ??= { v: " " });
      const to = target[i];
      if (s.v === to) continue;
      const cell = el.children[i] as HTMLElement | undefined;
      if (!cell) continue;
      if (!animate) {
        paint(cell, s.v, to, false);
        s.v = to;
        continue;
      }
      // walk the drum: a few letters leading to the target
      const L = DRUM.length;
      const idx = Math.max(0, DRUM.indexOf(to));
      const n = 2 + Math.floor(Math.random() * 4);
      const seq: string[] = [];
      for (let j = n - 1; j >= 0; j--) seq.push(DRUM[(idx - j + L) % L]);
      let k = 0;
      const run = () => {
        paint(cell, s.v, seq[k], true);
        s.v = seq[k];
        k++;
        if (k < seq.length) timers.push(window.setTimeout(run, 105));
      };
      timers.push(window.setTimeout(run, delay + i * 22));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [text, cells, delay]);

  return (
    <span className="rb-fd" ref={root} aria-hidden="true">
      {Array.from({ length: cells }, (_, i) => (
        <Cell key={i} />
      ))}
    </span>
  );
});

/* ------------------------------------------------------------------ */
/* board                                                               */
/* ------------------------------------------------------------------ */

interface SiftRow {
  line: string;
  key: string;
  side: string;
}

type Row =
  | {
      kind: "res";
      id: string;
      line: string;
      key: string;
      side: string;
      hasSide: boolean;
      min: number;
    }
  | { kind: "sift"; line: string; key: string; side: string }
  | { kind: "blank" };

export default function RouteBoard({
  routes,
  searching,
  progress,
  compare,
  flavor,
  maxRows,
  onSelect,
}: RouteBoardProps) {
  /* ---- measure the pane, pick layout + cell counts ---- */
  const rootRef = useRef<HTMLElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setW(Math.round(e.contentRect.width)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inner = w || 190;
  const wide = inner >= 310;
  const badge = BADGE_CELLS * CW;
  const time = TIME_CELLS * CW + 26;
  const arrow = 8;
  let keyN: number;
  let sideN: number;
  if (wide) {
    const avail = inner - badge - arrow - time - GAP * 4;
    keyN = clamp(Math.floor((avail * 0.52) / CW), 8, 24);
    sideN = clamp(Math.floor((avail - keyN * CW) / CW), 8, 24);
  } else {
    keyN = clamp(Math.floor((inner - badge - time - GAP * 2) / CW), 8, 24);
    sideN = clamp(Math.floor((inner - badge - GAP) / CW), 8, 28);
  }
  const statusN = clamp(Math.floor((inner - 7 - 3 * CW - 16) / CW), 12, 30);
  const max = maxRows ?? (wide ? 10 : 8);

  /* ---- status words ---- */
  const msgs =
    statusN >= 28 ? (compare ? MULTI : SINGLE) : compare ? MULTI_S : SINGLE_S;
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!searching) return;
    setPh(0);
    const id = window.setInterval(() => setPh((p) => (p + 1) % 4), STEP_MS);
    return () => window.clearInterval(id);
  }, [searching]);

  /* ---- sifting words while searching ---- */
  const words = flavor && flavor.length ? flavor : DEFAULT_FLAVOR;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const wkey = words.join("|");
  const [sift, setSift] = useState<SiftRow[]>([]);
  useEffect(() => {
    const mk = (): SiftRow => ({
      line: String(10 + Math.floor(Math.random() * 90)),
      key: pick(wordsRef.current),
      side: pick(PHRASES),
    });
    setSift(Array.from({ length: max }, mk));
    if (!searching || prefersReduced()) return;
    const id = window.setInterval(
      () => setSift((p) => [...p.slice(1), mk()]),
      SIFT_MS,
    );
    return () => window.clearInterval(id);
  }, [searching, max, wkey]);

  /* ---- rotate the side stops ---- */
  const multi = routes.some((r) => r.stops.length > 2);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!multi) return;
    const id = window.setInterval(() => setTick((t) => t + 1), SIDE_MS);
    return () => window.clearInterval(id);
  }, [multi]);

  /* ---- rows ---- */
  const sorted = useMemo(
    () =>
      [...routes].sort(
        (a, b) => a.minutes - b.minutes || a.id.localeCompare(b.id),
      ),
    [routes],
  );

  const rows: Row[] = Array.from({ length: max }, (_, i) => {
    const r = sorted[i];
    if (r) {
      const ks = clamp(r.keystone ?? 0, 0, Math.max(0, r.stops.length - 1));
      const others = r.stops.filter((_, j) => j !== ks);
      return {
        kind: "res",
        id: r.id,
        line: r.line,
        key: r.stops[ks] ?? "",
        side: others.length ? others[(tick + i) % others.length] : "Direct",
        hasSide: others.length > 0,
        min: Math.min(999, Math.round(r.minutes)),
      };
    }
    if (searching) {
      const s = sift[i];
      return {
        kind: "sift",
        line: s?.line ?? "",
        key: s?.key ?? "",
        side: s?.side ?? "",
      };
    }
    return { kind: "blank" };
  });

  /* ---- status line + progress ---- */
  const [done = 0, total = 0] = progress ?? [];
  const known = total > 0;
  const n = routes.length;
  const statusText = searching
    ? msgs[ph]
    : n
      ? `Live · ${n} ${n === 1 ? "route" : "routes"}`
      : "No routes found";
  const countText = known ? `${done}/${total}` : "";
  const frac = !searching ? 1 : known ? clamp(done / total, 0, 1) : 0;
  const srText = searching
    ? known
      ? `Searching, ${done} of ${total}`
      : "Searching"
    : n
      ? `${n} ${n === 1 ? "route" : "routes"} found, fastest ${sorted[0].minutes} minutes`
      : "No routes found";

  return (
    <section
      ref={rootRef}
      className={`rb ${wide ? "rb--wide" : "rb--narrow"}${
        searching ? "" : " rb--live"
      }`}
      aria-label="Route results"
    >
      <div className="rb-status">
        <span className="rb-dot" aria-hidden="true" />
        <span className="rb-sf">
          <FlapField text={statusText} cells={statusN} />
        </span>
        <span className="rb-cf">
          <FlapField text={countText} cells={3} />
        </span>
      </div>
      <div
        className={`rb-meter${known || !searching ? "" : " rb-indet"}`}
        aria-hidden="true"
      >
        <span
          className="rb-fill"
          style={{ transform: `scaleX(${frac})` } as CSSProperties}
        />
      </div>
      <div className="rb-sr" role="status" aria-live="polite">
        {srText}
      </div>

      <ol className="rb-rows" aria-label="Routes, fastest first">
        {rows.map((row, i) => {
          const isRes = row.kind === "res";
          const line = row.kind === "blank" ? "" : row.line;
          const key = row.kind === "blank" ? "" : row.key;
          const side =
            row.kind === "blank"
              ? ""
              : row.kind === "res" && !row.hasSide
                ? "Direct"
                : row.side;
          const keyField = <FlapField text={key} cells={keyN} delay={30} />;
          const sideField = <FlapField text={side} cells={sideN} delay={60} />;
          return (
            <li
              key={i}
              className={`rb-row rb-${row.kind}`}
              aria-hidden={isRes ? undefined : true}
            >
              <span className="rb-b">
                <FlapField
                  text={rightPad(line, BADGE_CELLS)}
                  cells={BADGE_CELLS}
                />
              </span>
              {isRes ? (
                <button
                  type="button"
                  className="rb-k rb-btn"
                  onClick={() => onSelect?.(row.id, row.key)}
                  aria-label={`${row.key}, line ${row.line}, ${row.min} minutes. Open details`}
                >
                  {keyField}
                </button>
              ) : (
                <span className="rb-k">{keyField}</span>
              )}
              <span className="rb-arrow" aria-hidden="true">
                ›
              </span>
              {isRes && row.hasSide ? (
                <button
                  type="button"
                  className="rb-s rb-btn"
                  onClick={() => onSelect?.(row.id, row.side)}
                  aria-label={`Also on this route: ${row.side}. Open details`}
                >
                  {sideField}
                </button>
              ) : (
                <span className="rb-s">{sideField}</span>
              )}
              <span className="rb-t">
                <FlapField
                  text={isRes ? rightPad(String(row.min), TIME_CELLS) : ""}
                  cells={TIME_CELLS}
                  delay={90}
                />
                <span className="rb-u">min</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
