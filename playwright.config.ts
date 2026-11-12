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
      name: "iphone",
      use: {
        ...devices["iPhone 14 Pro"],
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
