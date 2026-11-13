// Live-source health + ordered fallback. A source that throws or stalls goes
// on a short cooldown so a dead or hung upstream can't stall every call; the
// next source in the chain answers instead. Adding a provider (a hosted OBA
// region, the self-hosted SoCal instance) means a new name + one chain entry.
export type LiveSource = "oba" | "transit" | "octa-rt" | "metro-rt" | "index";

const DOWN_MS = 60_000;
const downUntil = new Map<LiveSource, number>();

export function sourceDown(s: LiveSource, now = Date.now()) {
  return (downUntil.get(s) ?? 0) > now;
}
export function reportSource(s: LiveSource, ok: boolean, now = Date.now()) {
  if (ok) downUntil.delete(s);
  else downUntil.set(s, now + DOWN_MS);
}
// Health is module state shared across callers — tests reset it.
export function resetSourceHealth() {
  downUntil.clear();
}

// Run fn() unless the source is on cooldown; timeoutMs bounds the wait so a
// hung upstream counts as a failure instead of freezing the caller. Throws
// never escape — they cool the source down and yield undefined.
export async function trySource<T>(
  s: LiveSource,
  fn: () => Promise<T | undefined>,
  opts: { timeoutMs?: number } = {},
): Promise<T | undefined> {
  if (sourceDown(s)) return undefined;
  let timedOut = false;
  const timeout =
    opts.timeoutMs === undefined
      ? undefined
      : new Promise<undefined>((res) =>
          setTimeout(() => {
            timedOut = true;
            res(undefined);
          }, opts.timeoutMs),
        );
  try {
    const v = timeout ? await Promise.race([fn(), timeout]) : await fn();
    reportSource(s, !timedOut);
    return v;
  } catch {
    reportSource(s, false);
    return undefined;
  }
}

// Ordered fallback: first source yielding a value wins. `source` comes back
// so callers can tag who answered — the accuracy-scoreboard seam.
export async function chainSources<T>(
  steps: [LiveSource, () => Promise<T | undefined>][],
  opts?: { timeoutMs?: number },
): Promise<{ value: T; source: LiveSource } | undefined> {
  for (const [s, fn] of steps) {
    const v = await trySource(s, fn, opts);
    if (v !== undefined) return { value: v, source: s };
  }
  return undefined;
}
