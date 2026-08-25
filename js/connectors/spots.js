// Spots connector — the POTA activator feed and the PSKReporter "who heard me"
// MQTT feed. Network and protocol only; every consumer renders off the events.
//
// Events: "pota" (detail: { spots, force, error }), "psk" (detail: the live
// reception-report Map), "log".
//
// Constraints worth knowing before changing anything here:
//
// - The spot filter text and the band/mode filters live here rather than in the
//   spots mini-app, because the map app renders the same filtered list and
//   cannot import that app. Both call getFilteredPotaSpots().
//
// - Reception reports expire here (PSK_TTL_MS), not in whatever draws them. The
//   map used to do it, which meant the Map only shrank while someone was looking
//   at it.
//
// - mqtt.js is loaded through js/vendor.js. It used to await a global the map
//   app assigned, so if that app had not mounted the wait was skipped and the
//   library was then reported missing.
import { formatFrequency, inferBandFromFrequency } from "../utils.js";
import { pskTopicForCall, parsePskSpot } from "../psk.js";
import { mqttReady } from "../vendor.js";

const POTA_SPOTS_URL = "https://api.pota.app/spot/activator";
// PSKReporter broker URLs to try in order (bare first, /mqtt fallback — the
// path requirement is broker-config-dependent and unconfirmed for this broker).
const PSK_URLS = ["wss://mqtt.pskreporter.info:1886", "wss://mqtt.pskreporter.info:1886/mqtt"];

// and the data it produces stay together.
let potaSpots = [];
let pskClient = null;
let pskSpots = new Map();   // receiver call -> {spot, ts}
let pskUrlIndex = 0;

// How long a reception report stays interesting. The map layer already dropped
// anything older than this when it drew, but expiry living in the renderer meant
// the Map only ever shrank while someone was looking at it: with the map tab
// closed, or showing POTA, the MQTT feed kept filling it and nothing emptied it.
// The connector owns the data, so the connector bounds it.
const PSK_TTL_MS = 15 * 60 * 1000;

function prunePskSpots(now = Date.now()) {
  const cutoff = now - PSK_TTL_MS;
  for (const [key, entry] of pskSpots) {
    if (entry.ts < cutoff) pskSpots.delete(key);
  }
}

// state.potaFilter (the spot-list search box text) and the
// The spot-list search text and the band/mode filters live here rather than in
// the spots mini-app, even though the controls are that app's UI: the map
// renders the same filtered list and cannot import an app. The spots app calls
// the setters; both consumers read getFilteredPotaSpots().
let potaFilter = "";

// Band/mode filters for the Spots tab's band/mode selects (js/apps/spots/index.js).
// Both hold a resolved concrete value ("20m", "FT8", ...) or "" for no filter —
// the app resolves its selects' "Radio" option against the live cat frequency/
// mode before calling the setters, so this connector doesn't need to know
// about "follow the radio" as a concept.
let bandFilter = "";
let modeFilter = "";

function parseSpotFrequencyHz(value) {
  const numeric = Number.parseFloat(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric < 1000) {
    return Math.round(numeric * 1_000_000);
  }

  if (numeric < 100000) {
    return Math.round(numeric * 1000);
  }

  return Math.round(numeric);
}

export function normalizePotaSpot(rawSpot) {
  if (!rawSpot || !rawSpot.activator || !rawSpot.frequency) {
    return null;
  }

  const frequencyHz = parseSpotFrequencyHz(rawSpot.frequency);
  const latitude = Number(rawSpot.latitude);
  const longitude = Number(rawSpot.longitude);
  const spotTime = rawSpot.spotTime ? new Date(`${rawSpot.spotTime}Z`) : null;

  return {
    id: String(rawSpot.spotId || `${rawSpot.activator}-${rawSpot.reference}-${rawSpot.frequency}`),
    activator: String(rawSpot.activator).toUpperCase(),
    frequencyHz,
    // Deliberately NOT escaped: this value is also written to an <input>
    // .value and the serial-log textarea. Escaping happens at each render site.
    frequencyText: frequencyHz ? formatFrequency(frequencyHz) : String(rawSpot.frequency),
    mode: String(rawSpot.mode || "").toUpperCase(),
    reference: rawSpot.reference || "",
    parkName: rawSpot.name || rawSpot.parkName || "",
    locationDesc: rawSpot.locationDesc || "",
    comments: rawSpot.comments || "",
    source: rawSpot.source || "",
    count: Number(rawSpot.count) || 0,
    expireMinutes: Number(rawSpot.expire) || 0,
    grid: (rawSpot.grid6 || rawSpot.grid4 || "").toUpperCase(),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    spotter: rawSpot.spotter || "",
    spotTime
  };
}

export const spots = Object.assign(new EventTarget(), {
  // Fetches the POTA activator-spot list and reports it on the "pota" event.
  async fetchPotaSpots(force = false) {
    try {
      const response = await fetch(POTA_SPOTS_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`POTA API returned ${response.status}`);
      }

      const payload = await response.json();
      potaSpots = Array.isArray(payload)
        ? payload.map(normalizePotaSpot).filter(Boolean)
        : [];
      spots.dispatchEvent(new CustomEvent("pota", { detail: { spots: potaSpots, force, error: null } }));
    } catch (error) {
      potaSpots = [];
      spots.dispatchEvent(new CustomEvent("pota", { detail: { spots: potaSpots, force, error } }));
    }
  },

  getPotaSpots() {
    return potaSpots;
  },

  // `potaSpots`, `state.potaFilter` -> `potaFilter`). See the potaFilter
  // header note above for why this lives on the connector.
  getFilteredPotaSpots() {
    const filter = potaFilter;
    const now = Date.now();

    return [...potaSpots]
      .filter((spot) => spot.expireMinutes > 0)
      .filter((spot) => {
        if (!filter) {
          return true;
        }

        return [
          spot.activator,
          spot.reference,
          spot.parkName,
          spot.locationDesc,
          spot.mode,
          spot.comments
        ]
          .join(" ")
          .toLowerCase()
          .includes(filter);
      })
      .filter((spot) => !bandFilter || inferBandFromFrequency(spot.frequencyHz) === bandFilter)
      .filter((spot) => !modeFilter || spot.mode.toUpperCase() === modeFilter.toUpperCase())
      .sort((a, b) => {
        const aTime = a.spotTime ? a.spotTime.getTime() : now;
        const bTime = b.spotTime ? b.spotTime.getTime() : now;
        return bTime - aTime;
      });
  },

  setPotaFilter(text) {
    potaFilter = text || "";
  },

  setBandFilter(band) {
    bandFilter = band || "";
  },

  setModeFilter(mode) {
    modeFilter = mode || "";
  },

  // Connects to the PSKReporter MQTT broker and subscribes to reports of who
  // heard `call`. The FT8-map-mode gate it
  // re-checked after the mqtt-ready await is now the caller-supplied
  // `isFt8Active()` predicate (js/apps/map/index.js's `effectiveMapMode`),
  // since that state lives outside this connector.
  async connectPsk(call, isFt8Active) {
    if (pskClient) return;
    if (!call) return;
    pskClient = "connecting"; // claim synchronously to close the double-connect race
    // Was `if (window.__mqttReady) await window.__mqttReady` — a global the map
    // app assigned. If the map had not mounted the wait was skipped entirely and
    // this then reported the library as unavailable. js/vendor.js loads it.
    const haveMqtt = await mqttReady();
    if (pskClient !== "connecting") return; // a newer connect/disconnect superseded us while awaiting
    // Bail if mqtt never loaded, or the caller says we've left FT8 mode while we awaited.
    if (!haveMqtt || !window.mqtt || !isFt8Active()) {
      pskClient = null;
      if (!haveMqtt || !window.mqtt) {
        spots.dispatchEvent(new CustomEvent("log", { detail: "PSKReporter: mqtt.js unavailable." }));
      }
      return;
    }

    const url = PSK_URLS[pskUrlIndex % PSK_URLS.length];
    const client = window.mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 8000 });
    pskClient = client;

    client.on("connect", () => {
      client.subscribe(pskTopicForCall(call));
      spots.dispatchEvent(new CustomEvent("log", { detail: `PSKReporter connected (${url}); listening for who heard ${call}.` }));
    });
    client.on("message", (_topic, payload) => {
      let msg; try { msg = JSON.parse(payload.toString()); } catch (_) { return; }
      const spot = parsePskSpot(msg);
      if (!spot) return;
      pskSpots.set(spot.call, { spot, ts: Date.now() });
      prunePskSpots();
      spots.dispatchEvent(new CustomEvent("psk", { detail: pskSpots }));
    });
    client.on("error", (err) => spots.dispatchEvent(new CustomEvent("log", { detail: `PSKReporter error: ${err.message}` })));
    client.on("close", () => {
      // If the bare URL never connected, try the /mqtt path next time.
      if (!client.connected) pskUrlIndex += 1;
      // Release the slot. reconnectPeriod is 0, so mqtt.js will not reconnect on
      // its own — and leaving the dead client in `pskClient` made the guard at
      // the top of connectPsk() reject every future attempt, so one dropped
      // connection killed the feed for the rest of the session with no error
      // anywhere. Only clear if this is still the current client: a newer
      // connect may already have replaced it.
      if (pskClient === client) pskClient = null;
    });
  },

  disconnectPsk() {
    if (pskClient) {
      const client = pskClient;
      pskClient = null;                     // before end(), so the close handler above no-ops
      try { client.end?.(true); } catch (_) {}
    }
    // Reports are only meaningful for a live session; keeping them across a
    // disconnect showed stale "heard you" markers as if they were current.
    pskSpots.clear();
  },

  getPskSpots() {
    prunePskSpots();
    return pskSpots;
  },
});
