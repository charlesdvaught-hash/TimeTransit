import { beforeEach, expect, it, vi } from "vitest";
import { chicago, type Itinerary, type Place } from "./core";

const hooks = vi.hoisted(() => ({ cells: [] as any[], cursor: 0 }));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [
      hooks.cells[index],
      (value: any) => {
        hooks.cells[index] =
          typeof value === "function" ? value(hooks.cells[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
    return hooks.cells[index];
  },
  useEffect() {},
}));
vi.mock("./api", () => ({ search: vi.fn(), plan: vi.fn(), nearby: vi.fn() }));
import { search, plan } from "./api";
import { useTimeTransit } from "./useTimeTransit";

function render() {
  hooks.cursor = 0;
  return useTimeTransit();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const first: Place = { ...chicago, id: "first", name: "First" };
const second: Place = { ...chicago, id: "second", name: "Second" };
const itinerary: Itinerary = {
  duration: 60,
  startTime: "2026-11-09T15:00:00Z",
  endTime: "2026-11-09T15:01:00Z",
  transfers: 0,
  legs: [],
};
beforeEach(() => {
  hooks.cells = [];
  vi.clearAllMocks();
});

it("keeps Explore streaming through stop, dwell and return edits", async () => {
  const pending = deferred<Itinerary>();
  vi.mocked(search).mockResolvedValue([first, second]);
  vi.mocked(plan).mockImplementation(async (_origin, place) =>
    place.id === first.id ? itinerary : pending.promise,
  );
  const running = render().run("Coffee");
  await vi.waitFor(() => expect(render().results).toHaveLength(1));
  const signal = vi.mocked(plan).mock.calls[0][3]!;
  render().addStop(first);
  let state = render();
  state.setStops(state.stops.map((stop) => ({ ...stop, dwell: 30 })));
  render().setBack(false);
  state = render();
  expect(signal.aborted).toBe(false);
  expect(state.exploreBusy).toBe(true);
  expect(state.tripBusy).toBe(false);
  expect(state.progress).toEqual([1, 2]);
  pending.resolve(itinerary);
  await running;
  expect(render().results).toHaveLength(2);
  expect(render().exploreBusy).toBe(false);
  expect(render().progress).toEqual([2, 2]);
});

it("cancels only optimization when trip inputs change", async () => {
  const pending = deferred<Place[]>();
  vi.mocked(search).mockReturnValue(pending.promise);
  render().addStop();
  const running = render().optimizeTrip();
  const signal = vi.mocked(search).mock.calls[0][2]!;
  expect(render().tripBusy).toBe(true);
  render().setBack(false);
  expect(signal.aborted).toBe(true);
  expect(render().tripBusy).toBe(false);
  pending.resolve([]);
  await running;
  expect(render().chain).toBeNull();
  expect(render().error).toBe("");
});

it("clears partial Explore results when departure changes and ignores late routes", async () => {
  const pending = deferred<Itinerary>();
  vi.mocked(search).mockResolvedValue([first, second]);
  vi.mocked(plan).mockImplementation(async (_origin, place) =>
    place.id === first.id ? itinerary : pending.promise,
  );
  const running = render().run("Coffee");
  await vi.waitFor(() => expect(render().results).toHaveLength(1));
  const signal = vi.mocked(plan).mock.calls[0][3]!;
  render().setDeparture("2026-11-10T16:00");
  expect(signal.aborted).toBe(true);
  expect(render().results).toEqual([]);
  expect(render().progress).toEqual([0, 0]);
  expect(render().exploreBusy).toBe(false);
  pending.resolve(itinerary);
  await running;
  expect(render().results).toEqual([]);
  expect(render().selected).toBeNull();
});
