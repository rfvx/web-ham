// Lookup connector — callsign lookup (QRZ/HamQTH via /api/callsign), POTA park
// names, and nearby POTA parks / SOTA summits. Fetches, parses, and returns or
// throws; the logger owns every piece of UI around it.
//
// Callsign credentials come from the settings connector and the encrypted secret
// store, and are sent to the app's own origin — the browser holds them, the
// server only relays.
import { settings } from "./settings.js";
import { getSecret } from "./secure-store.js";

// the fetch + cache stay together.
const parkNameCache = new Map();

export const lookup = Object.assign(new EventTarget(), {
  // Fetches /api/callsign and returns the parsed response payload
  // ({ message, result }), or throws on HTTP failure / abort.
  async lookupCallsign(callsign, { signal } = {}) {
    const s = settings.get();
    const body = { call: callsign };
    if (s.qrzUser) body.qrzUser = s.qrzUser;
    const qrzPass = getSecret("qrzPass"); if (qrzPass) body.qrzPass = qrzPass;
    if (s.hamqthUser) body.hamqthUser = s.hamqthUser;
    const hamqthPass = getSecret("hamqthPass"); if (hamqthPass) body.hamqthPass = hamqthPass;
    const response = await fetch("/api/callsign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Lookup failed");
    }
    return payload;
  },

  async lookupParkName(ref) {
    if (parkNameCache.has(ref)) return parkNameCache.get(ref);
    try {
      // encodeURIComponent, not raw interpolation: `ref` is whatever the operator
      // typed in the reference field, so a "/" walked the API path and a "?" or
      // "#" truncated it into a different request entirely.
      const res = await fetch(`https://api.pota.app/park/${encodeURIComponent(ref)}`);
      if (!res.ok) throw new Error(String(res.status));
      const park = await res.json();
      const name = [park?.name, park?.locationName].filter(Boolean).join(", ") || "";
      parkNameCache.set(ref, name);
      return name;
    } catch {
      parkNameCache.set(ref, "");
      return "";
    }
  },

  // Synchronous read of whatever lookupParkName has already cached for
  // `ref` (or "" if nothing cached yet). Used where a caller needs the
  // name without awaiting a fresh lookup, e.g. building a QSO from a form
  // right after the smart-field readout already resolved it.
  peekParkName(ref) {
    return parkNameCache.get(ref) || "";
  },

  // Fetches nearby POTA parks or SOTA summits around (latitude, longitude)
  // depending on `type` ("sota" fetches summits, anything else fetches
  // parks), sorted by distance ascending, capped to 8. Returns
  // { potaRefs, sotaRefs } with only the fetched side populated.
  async findNearbyRefs(latitude, longitude, type) {
    let refs;
    if (type === "sota") {
      const res = await fetch(`https://api.sotl.as/summits/near?lat=${latitude}&lon=${longitude}&maxDistance=30000&limit=8`);
      if (!res.ok) throw new Error(`SOTA API ${res.status}`);
      refs = (await res.json()).map((s) => ({
        ref: s.code,
        name: s.name,
        lat: s.coordinates?.latitude,
        lon: s.coordinates?.longitude
      }));
    } else {
      const d = 0.3; // ~30 km bounding box
      const res = await fetch(`https://api.pota.app/park/grids/${latitude - d}/${longitude - d}/${latitude + d}/${longitude + d}/0`);
      if (!res.ok) throw new Error(`POTA API ${res.status}`);
      refs = ((await res.json()).features || []).map((f) => ({
        ref: f.properties?.reference,
        name: f.properties?.name,
        lat: f.geometry?.coordinates?.[1],
        lon: f.geometry?.coordinates?.[0]
      }));
    }
    // ponytail: flat-earth distance, fine at 30 km scale
    const km = (r) => {
      const dLat = (r.lat - latitude) * 111;
      const dLon = (r.lon - longitude) * 111 * Math.cos((latitude * Math.PI) / 180);
      return Math.sqrt(dLat * dLat + dLon * dLon);
    };
    refs = refs
      .filter((r) => r.ref)
      .map((r) => ({ ...r, km: Number.isFinite(r.lat) && Number.isFinite(r.lon) ? km(r) : NaN }))
      .sort((a, b) => (Number.isFinite(a.km) ? a.km : 1e9) - (Number.isFinite(b.km) ? b.km : 1e9))
      .slice(0, 8);
    return type === "sota" ? { potaRefs: [], sotaRefs: refs } : { potaRefs: refs, sotaRefs: [] };
  },
});
