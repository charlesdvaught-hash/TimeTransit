import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig(({ mode }) => {
  const key = loadEnv(mode, ".", "").VITE_TRANSIT_API_KEY;
  return {
    plugins: [
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["icon.svg", "apple-touch-icon.png"],
        manifest: {
          name: "TimeTransit — Go by time, not distance",
          short_name: "TimeTransit",
          description:
            "Rank nearby places by real door-to-door journey time, walking included.",
          theme_color: "#0b1016",
          background_color: "#10151b",
          display: "standalone",
          start_url: ".",
          icons: [
            { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
            { src: "icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "icon-maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          globIgnores: ["**/scan/**", "**/places/**"],
          runtimeCaching: [
            {
              urlPattern: /\/scan\/.*\.json$/,
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "scan-index",
                expiration: { maxEntries: 5, maxAgeSeconds: 604800 },
              },
            },
            {
              urlPattern: /\/places\/.*\.json$/,
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "places-index",
                expiration: { maxEntries: 5, maxAgeSeconds: 604800 },
              },
            },
            {
              urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\//,
              handler: "CacheFirst",
              options: {
                cacheName: "basemap",
                expiration: { maxEntries: 500, maxAgeSeconds: 604800 },
              },
            },
            {
              urlPattern: /^https:\/\/(server|services)\.arcgisonline\.com\//,
              handler: "CacheFirst",
              options: {
                cacheName: "satellite",
                expiration: { maxEntries: 600, maxAgeSeconds: 604800 },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
              handler: "CacheFirst",
              options: {
                cacheName: "fonts",
                expiration: { maxEntries: 30, maxAgeSeconds: 2592000 },
              },
            },
            {
              urlPattern:
                /^https:\/\/(photon\.komoot\.io|api\.transitous\.org)\//,
              handler: "NetworkFirst",
              options: {
                cacheName: "transit-data",
                networkTimeoutSeconds: 8,
                expiration: { maxEntries: 150, maxAgeSeconds: 86400 },
              },
            },
          ],
        },
      }),
    ],
    server: {
      proxy: {
        "/transit": {
          target: "https://external.transitapp.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/transit/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (key) proxyReq.setHeader("apiKey", key);
            });
          },
        },
        "/gtfsrt": {
          target: "https://api.octa.net",
          changeOrigin: true,
          rewrite: (path) =>
            path.replace(/^\/gtfsrt/, "/GTFSRealTime/protoBuf") + ".aspx",
        },
      },
    },
  };
});
