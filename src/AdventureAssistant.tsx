// STAGE-6: chat panel that turns a sentence into a multi-stop plan.
// Mounted from Panel only when preferences.aiMode === "full".
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import {
  adventureGap,
  adventureQuery,
  applyAdventure,
  describeAdventure,
  resolveEventStops,
  type ChatMessage,
} from "./assistant";
import { time } from "./display";
import type { AdventurePlan } from "./contracts";
import type { TransitController } from "./useTimeTransit";

export function AdventureAssistant({
  controller,
}: {
  controller: TransitController;
}) {
  const [log, setLog] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const orb =
    controller.basemap === "satellite"
      ? "assistant-orb-satellite.svg"
      : "assistant-orb-dark.svg";
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const waiting = useRef<{ plan: AdventurePlan; term: string } | null>(null);
  // run() must observe the just-set dwell/back/departure state, so it fires
  // from an effect after React flushes instead of inline in the submit
  useEffect(() => {
    if (pending == null) return;
    setPending(null);
    controller.run(pending);
  });
  // once the planned chain lands, compare it against the return_by target
  useEffect(() => {
    const chain = controller.chain;
    const w = waiting.current;
    if (!chain || !w || controller.query !== w.term) return;
    waiting.current = null;
    const gap = adventureGap(w.plan, chain);
    if (gap)
      setLog((l) => [
        ...l,
        { role: "assistant", content: `Heads up — this plan ${gap}.` },
      ]);
  }, [controller.chain, controller.query]);
  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setLog((l) => [...l, { role: "user", content: text }]);
    const raw = await adventureQuery(text, history);
    if (!raw) {
      setBusy(false);
      setHistory((h) =>
        [...h, { role: "user" as const, content: text }].slice(-6),
      );
      setLog((l) => [
        ...l,
        {
          role: "assistant",
          content:
            "Sorry — I couldn't turn that into a plan. Try naming up to 4 stops or a time to be back by.",
        },
      ]);
      return;
    }
    const { plan, events } = await resolveEventStops(raw, controller.origin);
    const found = events.map(
      (e) =>
        `${e.title}${e.venue ? ` @ ${e.venue}` : ""} · ${time(new Date(e.start))}`,
    );
    const summary =
      `Got it: ${describeAdventure(plan)}` +
      (found.length ? ` — matched ${found.join("; ")}` : "");
    setHistory((h) =>
      [
        ...h,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: summary },
      ].slice(-6),
    );
    const a = applyAdventure(plan);
    controller.setBack(a.back);
    controller.setDeparture(a.departIso);
    a.dwells.forEach((d, i) => controller.setStopDwell(i, d));
    a.pins.forEach((p, i) => controller.setStopPin(i, p));
    waiting.current = { plan, term: a.term };
    setPending(a.term);
    setLog((l) => [...l, { role: "assistant", content: summary }]);
    setBusy(false);
  }
  return (
    <details className="utility-panel adventure-assistant">
      <summary>
        <img className="assistant-orb" src={orb} alt="" /> Plan an adventure
        <span>AI</span>
      </summary>
      <div className="adventure-log">
        {!log.length && (
          <p>Describe an outing — up to 4 stops, times, and a round trip.</p>
        )}
        {log.map((m, i) => (
          <p key={i} className={`adventure-msg ${m.role}`}>
            {m.role === "assistant" && (
              <img className="assistant-orb" src={orb} alt="" />
            )}
            {m.content}
          </p>
        ))}
        {busy && (
          <p className="adventure-msg assistant">
            <img className="assistant-orb" src={orb} alt="" />
            Thinking…
          </p>
        )}
      </div>
      <form className="adventure-form" onSubmit={send}>
        <input
          aria-label="Adventure request"
          maxLength={300}
          placeholder="e.g. lunch, then a museum, home by 6"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button title="Send" aria-label="Send" disabled={busy || !input.trim()}>
          <Send size={14} />
        </button>
      </form>
    </details>
  );
}
