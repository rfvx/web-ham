// Self-check for js/connectors/logbook.js findMatchingQso dedup. Run: node test-lotw-dedup.mjs
//
// Ports main@100e8e0's fix: findMatchingQso(lotwRecord) gained an
// `excludeIds` Set parameter so that two LoTW records which both match the
// same single logged QSO don't both resolve to it (the download/sync loop
// in js/apps/logger/index.js's downloadLotwAdif accumulates matched ids
// into a shared Set across the loop — see git show 100e8e0).
//
// logbook.js reads localStorage at module-eval time (initLogbooks()), so a
// minimal in-memory shim is installed before the import.
import assert from "node:assert";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { logbook } = await import("../js/connectors/logbook.js");

// Seed a single logged QSO.
logbook.replaceQsos([
  {
    id: "qso-1",
    callsign: "W1AW",
    band: "20M",
    mode: "FT8",
    date: "2026-05-01",
    time: "12:00",
  },
]);

// Two near-identical LoTW records that would both match the SAME QSO
// (same call/band/mode/date, times within the 15-minute window).
const recordA = {
  CALL: "W1AW",
  BAND: "20M",
  MODE: "DATA",
  QSO_DATE: "20260501",
  TIME_ON: "1200",
};
const recordB = {
  CALL: "W1AW",
  BAND: "20M",
  MODE: "DATA",
  QSO_DATE: "20260501",
  TIME_ON: "1205",
};

const matchedQsoIds = new Set();

const firstMatch = logbook.findMatchingQso(recordA, matchedQsoIds);
assert.ok(firstMatch, "first record should match the seeded QSO");
assert.equal(firstMatch.id, "qso-1");
matchedQsoIds.add(firstMatch.id);

const secondMatch = logbook.findMatchingQso(recordB, matchedQsoIds);
assert.equal(secondMatch, undefined, "second record must NOT re-match the already-consumed QSO");

// Signature is backward compatible: excludeIds defaults to an empty Set.
const noExcludeMatch = logbook.findMatchingQso(recordA);
assert.ok(noExcludeMatch, "excludeIds should default so callers without it still match");

console.log("logbook.js findMatchingQso dedup: all assertions passed");
