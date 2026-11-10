let warning = "";
export function storageWarning() {
  return warning;
}
export function readStored<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): T {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    warning =
      "Browser storage unavailable or damaged. Changes may not survive a reload.";
    return fallback;
  }
}
export function writeStored(key: string, value: unknown) {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(key, JSON.stringify(value));
  } catch {
    warning =
      "Browser storage is full or disabled. Data is kept only for this session.";
  }
}
