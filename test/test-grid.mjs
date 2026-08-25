// Self-check for js/grid.js pure helpers. Run: node test-grid.mjs
import assert from "node:assert";
import {
  maidenheadToLatLon, gridDistanceKm, gridBearingDeg, gridSquareBounds,
  BAND_COLORS, bandColor,
} from "../js/grid.js";
import { inferBandFromFrequency, mhzToBandName, BAND_PLAN, BAND_TO_KHZ } from "../js/utils.js";

// maidenhead: FN31 (approx 41.5N, 73W region)
const fn31 = maidenheadToLatLon("FN31");
assert.ok(Math.abs(fn31.latitude - 41.5) < 1.0, "FN31 lat");
assert.ok(Math.abs(fn31.longitude - (-73)) < 0.01, "FN31 lon");
assert.equal(maidenheadToLatLon("X"), null, "too short -> null");

// distance + bearing: FN31 (CT) -> IO91 (London) is ~5500 km, bearing roughly ENE (~50deg)
const d = gridDistanceKm("FN31", "IO91");
assert.ok(d > 5000 && d < 6000, `FN31->IO91 distance ~5500, got ${d}`);
const b = gridBearingDeg("FN31", "IO91");
assert.ok(b > 30 && b < 70, `FN31->IO91 bearing ~50, got ${b}`);
assert.equal(gridDistanceKm("FN31", "ZZ"), null, "bad grid -> null");

// grid-square cell bounds: 2° lon × 1° lat around the field center, ordered SW/NE
const gb = gridSquareBounds("FN31");
assert.ok(Math.abs((gb.ne[0] - gb.sw[0]) - 1.0) < 1e-9, "cell is 1deg tall");
assert.ok(Math.abs((gb.ne[1] - gb.sw[1]) - 2.0) < 1e-9, "cell is 2deg wide");
assert.ok(gb.sw[0] < fn31.latitude && fn31.latitude < gb.ne[0], "center lat inside cell");
assert.ok(gb.sw[1] < fn31.longitude && fn31.longitude < gb.ne[1], "center lon inside cell");
assert.equal(gridSquareBounds("X"), null, "bad grid -> null bounds");

// band colors
assert.equal(bandColor("20m"), "#F2C40C");
assert.equal(bandColor("40m"), "#5959FF");
assert.equal(bandColor("nonsense"), "#808080", "unknown -> grey");
assert.ok(BAND_COLORS["160m"], "palette populated");

// --- maidenhead validation -------------------------------------------------
// Out-of-range letters used to yield finite-but-wrong coordinates (ZZ00 -> lat
// 160.5 / lon 321), which passed a Number.isFinite guard and then blanked the
// map and corrupted satellite/rotator maths.
assert.equal(maidenheadToLatLon("ZZ00"), null, "field letters past R -> null");
assert.equal(maidenheadToLatLon("SS00"), null, "S is out of range -> null");
assert.equal(maidenheadToLatLon("FN3"), null, "5 chars is not a valid locator");
assert.equal(maidenheadToLatLon("FN31YY"), null, "subsquare letters past X -> null");
assert.equal(maidenheadToLatLon("FNAB"), null, "letters where digits belong -> null");
// Valid forms, including the extremes and a longer extended locator.
for (const g of ["AA00", "RR99", "FN31", "fn31", "FN31pr", "FN31XX", "JO65gh12"]) {
  const pt = maidenheadToLatLon(g);
  assert.ok(pt, `${g} should parse`);
  assert.ok(pt.latitude >= -90 && pt.latitude <= 90, `${g} latitude in range`);
  assert.ok(pt.longitude >= -180 && pt.longitude <= 180, `${g} longitude in range`);
}

// --- one canonical band plan ------------------------------------------------
// inferBandFromFrequency and mhzToBandName used to be separate tables that
// disagreed, so the same QSO could get a band from one and "" from the other.
// An empty band silently disables dupe detection, so these are data-integrity
// assertions, not cosmetics.
assert.equal(inferBandFromFrequency(446_000_000), "70cm", "446 MHz FM is 70cm");
assert.equal(inferBandFromFrequency(432_100_000), "70cm", "432.1 MHz is 70cm");
assert.equal(inferBandFromFrequency(5_330_500), "60m", "US 60m channel");
assert.equal(inferBandFromFrequency(14_074_000), "20m", "FT8 20m");
assert.equal(inferBandFromFrequency(136_800), "2200m", "2200m");
assert.equal(inferBandFromFrequency(999_000_000), "", "out of band -> empty");
assert.equal(inferBandFromFrequency(Number.NaN), "", "NaN -> empty");
// The two helpers must never disagree: same table, same answer.
for (const b of BAND_PLAN) {
  const mid = (b.minHz + b.maxHz) / 2;
  assert.equal(inferBandFromFrequency(mid), b.name, `${b.name} midpoint`);
  assert.equal(mhzToBandName(mid / 1_000_000), b.name, `${b.name} agrees via MHz`);
  assert.ok(BAND_TO_KHZ[b.name] > 0, `${b.name} has a BAND_TO_KHZ entry (else Cabrillo exports 0)`);
}
assert.equal(mhzToBandName(Number.NaN), "—", "NaN MHz -> em dash");
assert.ok(/MHz$/.test(mhzToBandName(999)), "unknown MHz falls back to a raw label");

console.log("grid.js + band plan: all assertions passed");
