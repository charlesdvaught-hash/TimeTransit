import { defineConfig, devices } from "@playwright/test";

// Mobile-first E2E: iPhone 14 Pro + Pixel 7 viewports. The dev server
// auto-starts; geolocation/heading mocks live in tests/fixtures.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173/TimeTransit/",
    trace: "retain-on-failure",
  },
  projects: [
    {
      // WebKit can't run on this Windows box (missing system DLLs), so
      // the iPhone project rides Chromium with iPhone dims/touch/UA —
      // real Safari quirks are handled defensively in code instead.
      name: "iphone",
      use: {
        viewport: { width: 393, height: 852 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        geolocation: { latitude: 33.7879, longitude: -118.1009 }, // Long Beach
        permissions: ["geolocation"],
      },
    },
    {
      name: "pixel",
      use: {
        ...devices["Pixel 7"],
        geolocation: { latitude: 33.7879, longitude: -118.1009 },
        permissions: ["geolocation"],
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5173",
    url: "http://localhost:5173/TimeTransit/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
