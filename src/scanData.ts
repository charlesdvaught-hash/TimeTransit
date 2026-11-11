import type { ScanIndex } from "./scan";

let promise: Promise<ScanIndex | undefined> | undefined;
export function loadScanIndex() {
  if (typeof window === "undefined") return Promise.resolve(undefined);
  promise ||= fetch(`${import.meta.env.BASE_URL}scan/octa.json`)
    .then((r) => (r.ok ? (r.json() as Promise<ScanIndex>) : undefined))
    .catch(() => undefined);
  return promise;
}
