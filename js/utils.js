/* Representative kHz per band, used when a QSO has a band but no frequency
   (Cabrillo needs a number). 60m and 2200m were missing, so such a QSO
   exported "QSO: 0". */
export const BAND_TO_KHZ = {
  "2200m": 136, "630m": 475,
  "160m": 1800, "80m": 3500, "60m": 5330, "40m": 7000, "30m": 10100,
  "20m": 14000, "17m": 18068, "15m": 21000, "12m": 24890, "10m": 28000,
  "6m": 50000, "2m": 144000, "70cm": 432000
};

export function formatSidebarVfo(hz) {
  if (!Number.isFinite(hz) || hz <= 0) {
    return "—.———.——";
  }
  const s = (hz / 1_000_000).toFixed(5);
  const [intPart, frac = ""] = s.split(".");
  return `${intPart}.${frac.slice(0, 3)}.${frac.slice(3, 5)}`;
}

/* One canonical band plan, in Hz. Two independent tables used to live here and
   disagreed: 70cm was 420-450 in one and 430-440 in the other, 60m was 5.0-6.0
   vs 5.3-5.41, and only one had 2200m. Because logger/index.js re-derives
   qso.band from the frequency on every save, a 446.000 FM or 5.35 MHz contact
   could come out with band:"" even though the UI displayed a band - and an empty
   band silently disables dupe detection entirely (logbook.js findDupe bails
   without one), empties the ADIF BAND field, and greys the map's band colour.

   Edges are deliberately inclusive where regions differ: 70cm spans the full US
   420-450 allocation rather than IARU R1's 430-440, and 60m spans 5.25-5.45 to
   cover both the US channels and the IARU segment. Amateur band edges are
   region-dependent, so this errs toward naming a band rather than returning "".
   Ordered narrow-to-wide is not required (ranges are disjoint). */
export const BAND_PLAN = [
  { name: "2200m", minHz: 135_700,     maxHz: 137_800 },
  { name: "630m",  minHz: 472_000,     maxHz: 479_000 },
  { name: "160m",  minHz: 1_800_000,   maxHz: 2_000_000 },
  { name: "80m",   minHz: 3_500_000,   maxHz: 4_000_000 },
  { name: "60m",   minHz: 5_250_000,   maxHz: 5_450_000 },
  { name: "40m",   minHz: 7_000_000,   maxHz: 7_300_000 },
  { name: "30m",   minHz: 10_100_000,  maxHz: 10_150_000 },
  { name: "20m",   minHz: 14_000_000,  maxHz: 14_350_000 },
  { name: "17m",   minHz: 18_068_000,  maxHz: 18_168_000 },
  { name: "15m",   minHz: 21_000_000,  maxHz: 21_450_000 },
  { name: "12m",   minHz: 24_890_000,  maxHz: 24_990_000 },
  { name: "10m",   minHz: 28_000_000,  maxHz: 29_700_000 },
  { name: "6m",    minHz: 50_000_000,  maxHz: 54_000_000 },
  { name: "2m",    minHz: 144_000_000, maxHz: 148_000_000 },
  { name: "70cm",  minHz: 420_000_000, maxHz: 450_000_000 }
];

/* Band name for a frequency in Hz, or "" when it falls outside every band. */
export function inferBandFromFrequency(frequencyHz) {
  if (!Number.isFinite(frequencyHz)) return "";
  const band = BAND_PLAN.find((b) => frequencyHz >= b.minHz && frequencyHz < b.maxHz);
  return band ? band.name : "";
}

/* Display variant: same table, MHz in, an em-dash or a raw MHz label out. */
export function mhzToBandName(mhz) {
  if (!Number.isFinite(mhz)) {
    return "—";
  }
  return inferBandFromFrequency(mhz * 1_000_000) || `${mhz.toFixed(2)} MHz`;
}

export function formatRelativeTimeUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "—";
  }
  const deltaSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

export function wait(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

export function formatFrequency(frequencyHz) {
  return `${(frequencyHz / 1_000_000).toFixed(6)} MHz`;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

export function percentile(values, fraction) {
  if (!values.length) {
    return NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

// Base64-encode bytes without blowing the call stack.
//
// `btoa(String.fromCharCode(...bytes))` passes one argument per byte, so it
// throws RangeError once the array is big enough — around 128 KB in Node and V8,
// and lower still in Safari. Both call sites feed it real user data: the LoTW
// .p12 certificate on attach, and the whole encrypted secret blob on every
// secure-store write (which contains that .p12). The failure was silent, because
// the attach path runs as `void attachLotwP12(event)` and the store's persist()
// only console.warns — you would attach a certificate, see its name appear, and
// find it gone on reload.
//
// Chunking keeps every fromCharCode call small and the output identical.
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000; // 32 KB of arguments per call, comfortably under every limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // Apostrophes matter the moment any caller uses single-quoted attributes.
    // Every current call site double-quotes, so this is defence in depth.
    .replaceAll("'", "&#39;");
}

export function normalizeToken(value) {
  return value.trim().toUpperCase();
}

export function normalizeReport(value) {
  const report = value.trim().toUpperCase();
  if (!report) {
    return "";
  }

  if (/^[+-]\d{2}$/.test(report)) {
    return report;
  }

  if (/^\d{2}$/.test(report)) {
    return `+${report}`;
  }

  return report;
}

export function parseFrequencyText(text) {
  const match = text.match(/[\d.]+/);
  if (!match) {
    return 0;
  }

  return Math.round(Number.parseFloat(match[0]) * 1_000_000);
}


export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_THEME = "system";

// Pure theme-string validator, shared by the shell's theme cluster and the
// settings app. Anything pure and shared across mini-app boundaries lives here
// rather than being duplicated.
export function normalizeThemePreference(theme) {
  return ["dark", "light", "system"].includes(theme) ? theme : DEFAULT_THEME;
}

// The FT8 calling frequency per band. Read by both the radio app (mode
// quick-set) and the FT8 app (band rows), hence here rather than in either.
export const FT8_BAND_FREQUENCIES = {
  "160m": 1840000,
  "80m":  3573000,
  "60m":  5357000,
  "40m":  7074000,
  "30m":  10136000,
  "20m":  14074000,
  "17m":  18100000,
  "15m":  21074000,
  "12m":  24915000,
  "10m":  28074000,
  "6m":   50313000,
  "2m":   144174000,
  "70cm": 432174000,
};

export const DIGI_LABEL_MAP = { DIGL: "Digi-L", DIGU: "Digi-U" };
export const DIGI_PATTERN = /^(DIG|DATA|PKT|FSK)/i;

export function digiDisplayLabel(rawLabel) {
  return DIGI_LABEL_MAP[rawLabel] || (DIGI_PATTERN.test(rawLabel) ? "Digi" : null);
}

/* Entry-pad tab flow (js/apps/logger/index.js binds this to the General pad).
   Operators drive a logger almost entirely from the Tab key, so the pad has two
   deliberate flows instead of one DOM walk:

     main  Callsign → Sent → Rcvd → Location → Rig → Power → Notes → wraps
     top   Frequency → Mode → Date → Time UTC → then joins main at its first field

   The top row holds what is constant across a run — it tracks the radio, or gets
   set once at the start of a session — so it stays out of the repeating loop. You
   reach it by clicking a field, tab out through the rest of that row, and land
   back in the main flow ready for the next QSO.

   This has to be managed rather than left to the browser, because the pad's CSS
   grid paints Frequency/Mode/Date/Time along the top while their inputs sit
   *after* Callsign in source order. Native Tab from Callsign therefore jumps up
   the form into Date, which is neither flow.

   Reverse is the mirror, with one deliberate asymmetry: Shift-Tab out of the
   first main field enters the top flow at its end, so the top row is reachable
   without a mouse. Forward Tab never enters it.

   Pure on purpose — `main` and `top` are arrays of whatever the caller is
   sequencing (elements in the app, strings in test-logger-tab-flow.mjs), so the
   ordering rules can be tested without a DOM. Returns the item to focus, or
   null to let the browser handle the keypress. */
export function nextTabTarget({ main = [], top = [], target, shift = false }) {
  const mi = main.indexOf(target);
  const ti = top.indexOf(target);
  if (mi < 0 && ti < 0) return null; // not a managed field
  const lastMain = main[main.length - 1] ?? null;

  if (shift) {
    // Leaving the first main field backwards opens the top flow at its end.
    if (mi === 0) return top[top.length - 1] ?? lastMain;
    if (mi > 0) return main[mi - 1];
    if (ti > 0) return top[ti - 1];
    return lastMain; // backwards off the top flow closes the cycle at Notes
  }

  if (mi >= 0) return main.length ? main[(mi + 1) % main.length] : null;
  return top[ti + 1] ?? main[0] ?? null; // top flow falls into main
}
