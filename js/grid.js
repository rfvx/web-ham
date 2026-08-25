// Shared grid/band math: Maidenhead <-> lat/lon, distance/bearing, band color
// palette, and FT8 grid-field extraction. Used by the spots connector, the
// map app, the satellites app, and ft8's decode pipeline — not FT8-specific
// despite living next to the ft8-* codecs historically. No DOM, no Leaflet —
// kept import-clean so test-grid.mjs can exercise it under plain node.
// (PSKReporter MQTT helpers now live in js/psk.js.)
import { normalizeToken } from "./utils.js";

/* Field letters A-R, squares 0-9, optional subsquare letters A-X. Without this
   check the maths happily accepts out-of-range letters and returns finite but
   nonsense coordinates - "ZZ00" came out as lat 160.5 / lon 321, which sails
   past a Number.isFinite guard and then blanks the Leaflet map, corrupts
   satellite AOS/LOS and rotator azimuth, and makes distance/bearing readouts
   meaningless. js/psk.js already validated its own input; this pushes the same
   check down into the shared helper so every caller gets it. */
const MAIDENHEAD_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/;

export function maidenheadToLatLon(grid) {
  const normalized = String(grid || "").trim().toUpperCase();
  if (normalized.length < 4) return null;
  /* Accept a longer locator by validating only the part we actually consume
     (4 or 6 chars), so extended 8-character grids still work. */
  const consumed = normalized.length >= 6 ? normalized.slice(0, 6) : normalized.slice(0, 4);
  if (!MAIDENHEAD_RE.test(consumed)) return null;
  let longitude = (normalized.charCodeAt(0) - 65) * 20 - 180;
  let latitude = (normalized.charCodeAt(1) - 65) * 10 - 90;
  longitude += Number.parseInt(normalized.slice(2, 3), 10) * 2;
  latitude += Number.parseInt(normalized.slice(3, 4), 10);
  if (normalized.length >= 6) {
    longitude += (normalized.charCodeAt(4) - 65) * (5 / 60) + 2.5 / 60;
    latitude += (normalized.charCodeAt(5) - 65) * (2.5 / 60) + 1.25 / 60;
  } else {
    longitude += 1;
    latitude += 0.5;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function gridDistanceKm(grid1, grid2) {
  const a = maidenheadToLatLon(grid1), b = maidenheadToLatLon(grid2);
  if (!a || !b) return null;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function gridBearingDeg(grid1, grid2) {
  const a = maidenheadToLatLon(grid1), b = maidenheadToLatLon(grid2);
  if (!a || !b) return null;
  const dLon = rad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(rad(b.latitude));
  const x = Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) -
    Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(dLon);
  return Math.round((deg(Math.atan2(y, x)) + 360) % 360);
}

// Bounding box of a 4-char Maidenhead field (2° lon × 1° lat) as {sw:[lat,lon], ne:[lat,lon]},
// for drawing GridTracker-style grid-square cells. FT8 decode grid fields are 4-char
// (ft8FindGridField slices to 4), so the half-cell is fixed at 0.5° lat / 1.0° lon.
export function gridSquareBounds(grid) {
  const c = maidenheadToLatLon(grid);
  if (!c) return null;
  return {
    sw: [c.latitude - 0.5, c.longitude - 1.0],
    ne: [c.latitude + 0.5, c.longitude + 1.0],
  };
}

// Find a grid field exposed in a decode message, skipping the roger/signoff
// tokens that also match the grid pattern ("RR73" = RR + 73). Returns "" if
// none. Moved here from the monolith's runFt8Decode/renderFt8Map: both
// the FT8 decode loop (the old monolith, stays there until the FT8 app task) and the
// map's FT8 layer (js/apps/map/index.js) need it, and it's pure — the
// "shared + pure -> here" rule js/apps/settings/index.js's header note
// documents for getLotwP12Meta applies the same way to this pure module.
export function ft8FindGridField(text) {
  const tokens = normalizeToken(text || "").replace(/\s+/g, " ").trim().split(" ");
  for (const t of tokens) {
    if (t === "RR73" || t === "RRR" || t === "73") continue;
    if (/^[A-R]{2}\d{2}([A-X]{2})?$/.test(t)) return t.slice(0, 4);
  }
  return "";
}

// PSKReporter / GridTracker band palette, color-picked from the legend image.
export const BAND_COLORS = {
  "2200m":"#FF4500","600m":"#1E90FF","160m":"#7CFC00","80m":"#E550E5","60m":"#00008B",
  "40m":"#5959FF","30m":"#62D962","20m":"#F2C40C","17m":"#F2F261","15m":"#C8A060",
  "12m":"#B22222","11m":"#00FF00","10m":"#FF69B4","8m":"#7F00F1","6m":"#FF0000",
  "5m":"#E0E0E0","4m":"#CC0044","2m":"#FF1493","1.25m":"#CCFF00","70cm":"#999900",
  "23cm":"#5AB8C7","uhf":"#FF9393","vlf":"#F88000","2.4Ghz":"#FF7F50","10Ghz":"#686868",
  "24Ghz":"#F0E8C0","47Ghz":"#F8E080","76Ghz":"#B8F8D8","5.8Ghz":"#CC0099","4000m":"#45E0FF",
};
export function bandColor(band) {
  return BAND_COLORS[String(band || "")] || "#808080";
}
// PSKReporter MQTT helpers (pskTopicForCall, parsePskSpot) used to live here;
// they moved to js/psk.js so this file is grid/band math only.
