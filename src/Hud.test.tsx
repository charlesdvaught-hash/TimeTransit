import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Hud } from "./Hud";
import type { TransitController } from "./useTimeTransit";
it("labels the routed trip rather than the current return toggle", () => {
  const controller = {
    back: false,
    total: 600,
    chain: { visits: [{}, {}], returnTrip: {} },
  } as unknown as TransitController;
  expect(renderToStaticMarkup(<Hud controller={controller} />)).toContain(
    "2 stops · round trip",
  );
  const oneWay = {
    ...controller,
    back: true,
    chain: { visits: [{}, {}] },
  } as unknown as TransitController;
  expect(renderToStaticMarkup(<Hud controller={oneWay} />)).not.toContain(
    "round trip",
  );
});
