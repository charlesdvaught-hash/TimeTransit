import { expect, test } from "@playwright/test";

test("app shell loads on mobile viewport", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".panel")).toBeVisible();
  expect(errors).toEqual([]);
});
