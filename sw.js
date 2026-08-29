const CACHE_NAME = "web-ham-logger-v42";
const APP_SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/manifest.webmanifest",
  // The installed app's own icons. An installed PWA re-reads these for its
  // launcher entry and splash screen, so an install that happens to go offline
  // before they are cached shows a blank icon.
  "/icons/favicon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  // The MQTT client the map app loads for PSKReporter live spots. It lives in
  // the repo under /vendor/, so unlike Leaflet (CDN-only) it CAN be served
  // offline — it was simply missing from this list. The broker itself needs
  // network; this only ensures the module loads instead of failing to fetch.
  "/vendor/mqtt/mqtt.min.js",
  // The ft8js decode/encode WASM engine, loaded dynamically from
  // js/apps/ft8/ft8-decoder.js via a vendor-relative URL. These live under
  // /vendor/, not /js/, so the js/*.js globs below don't catch them.
  "/vendor/ft8js/index.js",
  "/vendor/ft8js/decode.wasm",
  "/vendor/ft8js/encode.wasm",
  // The full ES module graph reachable from js/main.js. Every module needs
  // listing: main.js is a small entry point that imports ~30 others, and an
  // unlisted one is fetched concurrently with SW install and may never land in
  // the cache — so an offline reload gets a fetch failure for a JS request
  // instead of a hit. check.sh asserts this stays in sync with
  // `git ls-files 'js/*.js' 'js/**/*.js'`.
  "/js/main.js",
  "/js/bus.js",
  "/js/grid.js",
  "/js/psk.js",
  "/js/utils.js",
  "/js/vendor.js",
  "/js/serial-log.js",
  "/js/shell/shell.js",
  "/js/shell/notice.js",
  "/js/shell/onboarding.js",
  "/js/connectors/audio.js",
  "/js/connectors/cat.js",
  "/js/connectors/logbook.js",
  "/js/connectors/lookup.js",
  "/js/connectors/rotator.js",
  "/js/connectors/settings.js",
  "/js/connectors/spots.js",
  // These three were missing, and secure-store is the one that mattered:
  // js/main.js `await initSecureStore()` at top level, so offline its fetch
  // rejected, the module graph never finished, and the app did not boot at all —
  // the exact case the precache exists to prevent. check.sh now diffs this list
  // against `git ls-files` so it cannot drift again.
  "/js/connectors/secure-store.js",
  "/js/connectors/contests-generated.js",
  "/js/connectors/rigs-generated.js",
  "/js/apps/audio-macros/index.js",
  "/js/apps/ft8/index.js",
  "/js/apps/ft8/audio.js",
  "/js/apps/ft8/decode.js",
  "/js/apps/ft8/ft8-decoder.js",
  "/js/apps/ft8/ft8-encoder.js",
  "/js/apps/logger/index.js",
  "/js/apps/map/index.js",
  "/js/apps/radio/index.js",
  "/js/apps/satellites/index.js",
  "/js/apps/settings/index.js",
  "/js/apps/spots/index.js",
  "/js/apps/sstv/index.js"
];

const NETWORK_FIRST_PATHS = new Set([
  "/",
  "/index.html",
  "/styles.css",
  "/js/main.js",
  "/manifest.webmanifest",
  "/sw.js",
  "/api/time",
  "/api/tle"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Only navigation/document requests should ever fall back to the HTML
// shell — serving index.html for a failed script/module fetch hands the
// browser HTML with a JS content-type, which is a parse error, not a
// fallback. Everything else must let the failure propagate.
function isDocumentRequest(request) {
  return request.mode === "navigate" || request.destination === "document";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate" || NETWORK_FIRST_PATHS.has(requestUrl.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const responseClone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          return isDocumentRequest(request) ? caches.match("/index.html") : Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const responseClone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(() => (isDocumentRequest(request) ? caches.match("/index.html") : Response.error()));
    })
  );
});
