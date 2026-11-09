export const minutes = (s: number) => Math.ceil(s / 60);
export const time = (s: string | Date) =>
  new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const transfers = (count: number) =>
  count + " " + (count === 1 ? "transfer" : "transfers");
