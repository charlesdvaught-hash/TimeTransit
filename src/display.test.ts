import { expect, it } from "vitest";
import { transfers } from "./display";
it("uses singular for one transfer and plural otherwise", () => {
  expect(transfers(0)).toBe("0 transfers");
  expect(transfers(1)).toBe("1 transfer");
  expect(transfers(2)).toBe("2 transfers");
});
