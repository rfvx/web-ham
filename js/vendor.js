// Lazily loads the two third-party libraries WebHam cannot ship as ES modules:
// Leaflet (the map) and mqtt.js (the PSKReporter feed). Both are classic scripts
// that install a global (`window.L`, `window.mqtt`), so the global is theirs and
// unavoidable — what this module removes is the *handshake* being global too.
//
// It used to be `window.__leafletReady` / `window.__mqttReady`, assigned by the
// map mini-app and awaited by the spots connector. That inverted the layering:
// connectors sit below apps and must not wait on something an app happens to
// have assigned. If the map app never mounted — a future build that drops the
// tab, an app whose mount() threw — `window.__mqttReady` was simply undefined
// and the spots connector silently skipped the wait, then found no `window.mqtt`
// and reported the library as unavailable.
//
// Now both sides import this module and call the same function. Loading is
// idempotent and memoised: the first caller starts the fetch, everyone else
// awaits the same promise.
//
// Each library is tried from the local vendor copy first and a CDN second, so an
// offline install works when the vendor files are present and still functions
// online when they are not. A load failure resolves `false` rather than
// rejecting — the callers all degrade (the map shows a message, PSK reports a
// missing library), and an unhandled rejection at import time would be worse
// than a feature that is simply off.

// Insert a <link> or <script> once, keyed by URL, and resolve when it loads.
// Both tag types share everything except the element they build, which is the
// only reason the three separate copies of this that used to exist ever differed.
function loadTag(url, build) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`[data-vendor-src="${CSS.escape(url)}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") resolve();
      else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`vendor load failed: ${url}`)), { once: true });
      }
      return;
    }
    const el = build(url);
    el.dataset.vendorSrc = url;
    el.onload = () => { el.dataset.loaded = "true"; resolve(); };
    el.onerror = () => { el.remove(); reject(new Error(`vendor load failed: ${url}`)); };
    document.head.appendChild(el);
  });
}

const asStylesheet = (href) => Object.assign(document.createElement("link"), { rel: "stylesheet", href });
const asScript = (src) => Object.assign(document.createElement("script"), { src, defer: true });

// Try each candidate in order; the first that loads wins.
async function loadFirst(build, candidates) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await loadTag(candidate, build);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no candidates");
}

// Memoised per library: repeated calls return the same in-flight or settled
// promise, so the map app and the spots connector racing at boot load one copy.
const started = new Map();
function once(name, run) {
  if (!started.has(name)) started.set(name, run());
  return started.get(name);
}

export function leafletReady() {
  return once("leaflet", async () => {
    try {
      await Promise.all([
        loadFirst(asStylesheet, ["./vendor/leaflet/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"]),
        loadFirst(asScript, ["./vendor/leaflet/leaflet.js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"]),
      ]);
    } catch {
      return false;
    }
    return Boolean(window.L);
  });
}

export function mqttReady() {
  return once("mqtt", async () => {
    try {
      await loadFirst(asScript, ["./vendor/mqtt/mqtt.min.js", "https://unpkg.com/mqtt@5/dist/mqtt.min.js"]);
    } catch {
      return false;
    }
    return Boolean(window.mqtt);
  });
}
