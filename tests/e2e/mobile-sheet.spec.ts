import { test, expect } from "@playwright/test";

test("mobile sheet snap states", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(1500);
  // default = half
  await expect(page.locator(".panel.snap-half")).toBeVisible();
  // tap grabber → peek
  await page.locator(".panel-grabber").tap();
  await page.waitForTimeout(400);
  await expect(page.locator(".panel.snap-peek")).toBeVisible();
  // tap again → half
  await page.locator(".panel-grabber").tap();
  await page.waitForTimeout(400);
  await expect(page.locator(".panel.snap-half")).toBeVisible();
  // drag grabber up → full
  const box = await page.locator(".panel-grabber").boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 300, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(page.locator(".panel.snap-full")).toBeVisible();
});
