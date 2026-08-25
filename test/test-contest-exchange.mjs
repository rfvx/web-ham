// Pure unit tests for the composable contest exchange system in
// js/connectors/logbook.js: composeExchange, nextSerial, and the derived
// backward-compat fields on CONTESTS. Run: node test-contest-exchange.mjs
//
// localStorage isn't available in node; logbook.js touches it at module-eval
// time (initLogbooks) and in nextSerial (loadQsos). Provide a minimal stub
// before importing so both work headless.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// node >=19 already provides globalThis.crypto.randomUUID (used by logbook.js
// at module-eval time), so no stub is needed here.

const { CONTESTS, EXCHANGE_FIELDS, composeExchange, nextSerial, cabrilloContestKeyword, cabrilloCategoryLines, CABRILLO_CATEGORIES, logbook } =
  await import("../js/connectors/logbook.js");
const { settings } = await import("../js/connectors/settings.js");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("FAIL:", msg); }
}
function eq(a, b, msg) { assert(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ── composeExchange: joins in order, skips blank/undefined ──────────────────
eq(composeExchange(["rst", "cqzone"], { rst: "599", cqzone: "5" }), "599 5", "compose in order");
eq(composeExchange(["rst", "serial"], { rst: "59", serial: "001" }), "59 001", "compose serial");
eq(composeExchange(["rst", "state"], { rst: "59", state: "" }), "59", "skip empty string");
eq(composeExchange(["rst", "power"], { rst: "59" }), "59", "skip missing key");
eq(composeExchange(["state", "rst"], { rst: "59", state: "MN" }), "MN 59", "respects field order, not value order");
eq(composeExchange(["rst", "name"], { rst: "  59  ", name: "  Pat " }), "59 Pat", "trims values");
eq(composeExchange([], { rst: "59" }), "", "empty field list -> empty string");
eq(composeExchange(["cqzone"], { cqzone: 5 }), "5", "coerces non-string values");

// ── nextSerial: 1-based count of logged QSOs, zero-padded to 3 ──────────────
const bookId = "unit-book";
const qsoKey = `web-ham-logger.qsos.${bookId}`;
store.set(qsoKey, JSON.stringify([]));
eq(nextSerial({ id: bookId }), "001", "nextSerial empty log -> 001");
store.set(qsoKey, JSON.stringify([{ id: "a" }, { id: "b" }]));
eq(nextSerial({ id: bookId }), "003", "nextSerial with 2 QSOs -> 003");
store.set(qsoKey, JSON.stringify(new Array(120).fill({})));
eq(nextSerial({ id: bookId }), "121", "nextSerial pads only up to 3, longer numbers pass through");

// Serials come from the highest already issued, not the QSO count — otherwise
// deleting a QSO re-issues a number that already went out over the air.
const withSerials = (...ns) => JSON.stringify(ns.map((n) => ({ exchFields: { sent: { serial: n } } })));
store.set(qsoKey, withSerials("001", "002", "003", "004", "005"));
eq(nextSerial({ id: bookId }), "006", "nextSerial follows the highest issued serial");
store.set(qsoKey, withSerials("001", "002", "004", "005")); // 003 deleted
eq(nextSerial({ id: bookId }), "006", "deleting a QSO does not re-issue its serial");
store.set(qsoKey, withSerials("001"));
eq(nextSerial({ id: bookId }), "002", "a single logged serial advances to the next");
// Out-of-order and unparseable values must not throw or win.
store.set(qsoKey, withSerials("007", "002", "", "abc", "004"));
eq(nextSerial({ id: bookId }), "008", "highest wins regardless of order; blanks/garbage ignored");
// A mix of serial-bearing and legacy QSOs: the recorded serials still govern.
store.set(qsoKey, JSON.stringify([{ id: "legacy" }, { exchFields: { sent: { serial: "012" } } }]));
eq(nextSerial({ id: bookId }), "013", "recorded serials beat the count when both are present");

// ── EXCHANGE_FIELDS catalog sanity ──────────────────────────────────────────
eq(EXCHANGE_FIELDS.rst.auto, "rst", "rst is auto from the report field");
eq(EXCHANGE_FIELDS.serial.auto, "serial", "serial is auto-increment");
assert(EXCHANGE_FIELDS.name.wide === true, "name is a wide field");
assert(EXCHANGE_FIELDS.cqzone.auto === undefined, "cqzone is a typed field (no auto)");

// ── Derived backward-compat fields on CONTESTS ──────────────────────────────
const byId = Object.fromEntries(CONTESTS.map((c) => [c.id, c]));

// CQ-WPX: sent includes serial -> serial:true; rcvd non-rst -> "Nr"
eq(byId["CQ-WPX"].serial, true, "CQ-WPX derived serial=true");
eq(byId["CQ-WPX"].exch, "Nr", "CQ-WPX derived exch label");

// CQ-WW: no serial; rcvd [rst,cqzone] -> exch "CQ Zone"
eq(byId["CQ-WW"].serial, false, "CQ-WW derived serial=false");
eq(byId["CQ-WW"].exch, "CQ Zone", "CQ-WW derived exch label");

// NAQP: rcvd [name,state] -> "Name + State/Prov", not a serial contest
eq(byId["NAQP"].serial, false, "NAQP derived serial=false");
eq(byId["NAQP"].exch, "Name + State/Prov", "NAQP derived exch label");

// ARRL-SS: the real exchange is serial + precedence + check + section, and no
// signal report. (This used to assert "Nr + Exchange" against a placeholder
// `text` field, which is why SS logs exported as a bare serial.)
eq(byId["ARRL-SS"].serial, true, "ARRL-SS derived serial=true");
eq(byId["ARRL-SS"].exch, "Nr + Prec + Check + ARRL Sect", "ARRL-SS derived exch label");
eq(byId["ARRL-SS"].sent.join(","), "serial,prec,check,section", "ARRL-SS sends serial+prec+check+section");
eq(byId["ARRL-SS"].rcvd.join(","), "serial,prec,check,section", "ARRL-SS receives serial+prec+check+section");
assert(!byId["ARRL-SS"].sent.includes("rst"), "ARRL-SS exchanges no signal report");
eq(byId["ARRL-SS"].me.join(","), "prec,check,section", "ARRL-SS fixes prec/check/section per logbook");

// me-fields never contain auto fields
for (const c of CONTESTS) {
  assert(!c.me.includes("rst") && !c.me.includes("serial"), `${c.id}: me excludes auto fields`);
  // every me field must be part of the sent template
  assert(c.me.every((k) => c.sent.includes(k)), `${c.id}: me is a subset of sent`);
  // every key references a real catalog entry
  assert([...c.sent, ...c.rcvd].every((k) => EXCHANGE_FIELDS[k]), `${c.id}: all field keys exist in EXCHANGE_FIELDS`);
}

// Every contest id must have an explicit keyword entry — a missing entry now
// means "unrecognised", so a new contest added without one exports as UNKNOWN.
for (const c of CONTESTS) {
  const { keyword, warning } = cabrilloContestKeyword(c.id, [{ mode: "CW" }]);
  assert(keyword !== "UNKNOWN" || warning !== "", `${c.id}: unresolved keyword carries a warning`);
  assert(/^[A-Z0-9-]{1,32}$/.test(keyword), `${c.id}: keyword "${keyword}" is Cabrillo-legal (A-Z 0-9 -, <=32)`);
}

// ── cabrilloContestKeyword ──────────────────────────────────────────────────
// Values are the sponsors' own keywords, not a pattern: ARRL 10 Meter is one
// mode-agnostic keyword, Sweepstakes is always suffixed, Field Day's keyword
// is nothing like our internal id.
const cw = [{ mode: "CW" }], ssb = [{ mode: "SSB" }, { mode: "USB" }];
const kw = (id, qsos) => cabrilloContestKeyword(id, qsos).keyword;
const warn = (id, qsos) => cabrilloContestKeyword(id, qsos).warning;

eq(kw("CQ-WW", cw), "CQ-WW-CW", "CQ-WW all-CW");
eq(kw("CQ-WW", ssb), "CQ-WW-SSB", "CQ-WW all-phone");
eq(kw("CQ-WPX", cw), "CQ-WPX-CW", "CQ-WPX all-CW");
eq(kw("CQ-WPX", [{ mode: "RTTY" }]), "CQ-WPX-RTTY", "CQ-WPX RTTY has its own keyword");
eq(kw("ARRL-DX", ssb), "ARRL-DX-SSB", "ARRL-DX all-phone");
eq(kw("NAQP", [{ mode: "RTTY" }]), "NAQP-RTTY", "NAQP RTTY");

// ARRL 10 Meter is a single mode-agnostic keyword. The old heuristic treated it
// as mode-split and fabricated "ARRL-10-CW", which no log checker accepts.
eq(kw("ARRL-10", cw), "ARRL-10", "ARRL-10 is mode-agnostic on CW");
eq(kw("ARRL-10", ssb), "ARRL-10", "ARRL-10 is mode-agnostic on phone");
eq(kw("ARRL-10", [{ mode: "CW" }, { mode: "SSB" }]), "ARRL-10", "ARRL-10 mixed-mode is still ARRL-10");

// Field Day's official keyword is ARRL-FIELD-DAY; the old code shipped our
// internal "ARRL-FD" onto the wire.
eq(kw("ARRL-FD", cw), "ARRL-FIELD-DAY", "Field Day uses its official keyword, not our id");
eq(warn("ARRL-FD", cw), "", "Field Day resolves cleanly");

// Sweepstakes is never valid bare — the old code emitted "ARRL-SS".
eq(kw("ARRL-SS", cw), "ARRL-SS-CW", "ARRL-SS CW");
eq(kw("ARRL-SS", ssb), "ARRL-SS-SSB", "ARRL-SS phone");

eq(kw("IARU-HF", cw), "IARU-HF", "IARU-HF is a single keyword");
eq(kw("CQ-WW-RTTY", [{ mode: "RTTY" }]), "CQ-WW-RTTY", "CQ-WW-RTTY is already mode-specific");
eq(kw("ARRL-VHF-JUN", [{ mode: "FM" }]), "ARRL-VHF-JUN", "each ARRL VHF running has its own keyword");

// Contest-list additions (toward N1MM's set). Every keyword here is on the
// WA7BNM canonical CONTEST: list; these assert the exact string a submitted log
// would carry, not just that something resolved.
eq(kw("CQ-160", cw), "CQ-160-CW", "CQ 160 CW");
eq(kw("CQ-160", ssb), "CQ-160-SSB", "CQ 160 phone");
eq(kw("NA-SPRINT", cw), "NA-SPRINT-CW", "NA Sprint CW");
eq(kw("NA-SPRINT", ssb), "NA-SPRINT-SSB", "NA Sprint phone");
eq(kw("SAC", cw), "SAC-CW", "SAC CW");
eq(kw("SAC", ssb), "SAC-SSB", "SAC phone");
eq(kw("OCEANIA-DX", cw), "OCEANIA-DX-CW", "Oceania DX CW");
eq(kw("OCEANIA-DX", ssb), "OCEANIA-DX-SSB", "Oceania DX phone");
eq(kw("ARRL-160", cw), "ARRL-160", "ARRL 160 is mode-agnostic");
eq(kw("STEW-PERRY", cw), "STEW-PERRY", "Stew Perry is a single keyword");
eq(kw("ARRL-UHF-AUG", [{ mode: "FM" }]), "ARRL-UHF-AUG", "ARRL August UHF");
eq(kw("CQ-VHF", [{ mode: "FM" }]), "CQ-VHF", "CQ WW VHF");
// A mode-split addition must still refuse a category it has no keyword for
// (these are HF contests with no FM leg), rather than inventing one.
eq(kw("CQ-160", [{ mode: "FM" }]), "UNKNOWN", "CQ 160 has no FM category");
assert(warn("CQ-160", [{ mode: "FM" }]) !== "", "CQ 160 FM refusal carries a warning");

// ── More of N1MM's set (this task). Every keyword below was cross-checked via
// WebSearch against the sponsor's own Cabrillo/rules page (JARL, DARC, RDXC,
// ARRL, WWROF) because the canonical WA7BNM/N1MM list is egress-blocked in CI.
// These assert the exact wire string a submitted log would carry.
const rtty = [{ mode: "RTTY" }];
eq(kw("ARRL-RTTY", rtty), "ARRL-RTTY", "ARRL RTTY Roundup is one keyword");
eq(kw("ARRL-RTTY", cw), "ARRL-RTTY", "ARRL RTTY Roundup keyword is mode-agnostic");
eq(kw("AADX", cw), "AADX-CW", "All Asian DX CW (JARL keyword, not the guessed AA-CW)");
eq(kw("AADX", ssb), "AADX-SSB", "All Asian DX phone");
eq(kw("AADX", [{ mode: "RTTY" }]), "UNKNOWN", "All Asian DX has no RTTY category");
assert(warn("AADX", rtty) !== "", "All Asian DX RTTY refusal carries a warning");
eq(kw("JIDX", cw), "JIDX-CW", "Japan Int'l DX CW");
eq(kw("JIDX", ssb), "JIDX-SSB", "Japan Int'l DX phone");
eq(kw("RDXC", cw), "RDXC", "Russian DX is one keyword on CW");
eq(kw("RDXC", ssb), "RDXC", "Russian DX is one keyword on phone");
eq(kw("RDXC", [{ mode: "CW" }, { mode: "SSB" }, { mode: "RTTY" }]), "RDXC",
   "Russian DX is mode-agnostic — mixed modes still resolve to one keyword");
eq(kw("WAE", cw), "DARC-WAEDC-CW", "WAE DX CW (DARC keyword)");
eq(kw("WAE", ssb), "DARC-WAEDC-SSB", "WAE DX phone");
eq(kw("WAE", rtty), "DARC-WAEDC-RTTY", "WAE DX RTTY has its own leg");
eq(kw("WW-DIGI", [{ mode: "FT8" }]), "WW-DIGI", "WW Digi is one keyword (FT8 -> DG code)");

// Single-source-of-truth contract: every contest row carries an explicit `cab`
// (a keyword, a byMode map, or null). A row that forgets it would silently
// export UNKNOWN, so lock it — this is what makes CABRILLO_KEYWORDS derivable.
for (const c of CONTESTS) {
  assert("cab" in c, `${c.id}: carries an explicit cab (Cabrillo keyword source of truth)`);
}
// A string `cab` must be exactly the resolved keyword (proves the derivation is
// wired, not that a parallel table happens to agree).
for (const c of CONTESTS) {
  if (typeof c.cab === "string") {
    eq(kw(c.id, cw), c.cab, `${c.id}: string cab is the resolved keyword`);
  }
}

// Refusals: a mixed-mode log, an empty log, a mode the contest has no category
// for, the legacy generic VHF id, a custom contest, and an unknown id all yield
// UNKNOWN *with* a warning rather than a plausible-looking wrong keyword.
eq(kw("CQ-WW", [{ mode: "CW" }, { mode: "SSB" }]), "UNKNOWN", "CQ-WW mixed modes refuses to guess");
assert(/mixes modes/.test(warn("CQ-WW", [{ mode: "CW" }, { mode: "SSB" }])), "mixed-mode warning explains why");
eq(kw("CQ-WW", []), "UNKNOWN", "CQ-WW with no QSOs refuses to guess");
assert(warn("CQ-WW", []) !== "", "empty-log keyword carries a warning");
eq(kw("CQ-WW", [{ mode: "RTTY" }]), "UNKNOWN", "CQ-WW has no RTTY category (that is CQ-WW-RTTY)");
eq(kw("VHF", [{ mode: "FM" }]), "UNKNOWN", "legacy generic VHF has no keyword");
assert(/January\/June\/September/.test(warn("VHF", [{ mode: "FM" }])), "legacy VHF warning names the runnings");
eq(kw("OTHER", cw), "UNKNOWN", "custom contest has no keyword we can know");
eq(kw(null, cw), "UNKNOWN", "null id -> UNKNOWN");
assert(warn(null, cw) !== "", "null id carries a warning");
eq(kw("NOT-A-CONTEST", cw), "UNKNOWN", "unrecognised id -> UNKNOWN");

// ── generateCabrilloText (via logbook.toCabrillo) ───────────────────────────
// This function had no coverage at all, which is how the RST column shift
// shipped. Column positions are the whole point of Cabrillo, so assert on them.
settings.set({ stationCall: "N0CALL", ft8MyGrid: "EN34" }, { silent: true });

const cabBook = (id, contest, qsos) => {
  store.set(`web-ham-logger.qsos.${id}`, JSON.stringify(qsos));
  return { id, name: id, type: "contest", meta: { contest } };
};
const qsoLines = (text) => text.split("\n").filter((l) => l.startsWith("QSO:"));
const header = (text, tag) =>
  (text.split("\n").find((l) => l.startsWith(`${tag}:`)) || "").slice(tag.length + 1).trim();

// A contest that DOES exchange RST: freq, mode, date, time, mycall, rst, exch,
// theircall, rst, exch.
const wwText = logbook.toCabrillo(cabBook("cab-ww", "CQ-WW", [
  { date: "2026-11-28", time: "14:30", callsign: "g3abc", mode: "CW",
    frequency: "14.025", band: "20m", rstSent: "599", rstReceived: "599",
    exchSent: "5", exchRcvd: "14" },
]));
eq(header(wwText, "CONTEST"), "CQ-WW-CW", "CQ-WW CW log gets the CW keyword");
eq(header(wwText, "CALLSIGN"), "N0CALL", "callsign header is upper-cased");
eq(header(wwText, "GRID-LOCATOR"), "EN34", "grid header from settings");
eq(qsoLines(wwText)[0], "QSO: 14025 CW 2026-11-28 1430 N0CALL 599 5 G3ABC 599 14",
   "CQ-WW QSO line carries both RST columns");
assert(wwText.startsWith("START-OF-LOG: 3.0\n"), "log opens with START-OF-LOG");
assert(wwText.endsWith("END-OF-LOG:\n"), "log closes with END-OF-LOG");
eq(header(wwText, "X-WEBHAM-WARNING"), "", "a resolvable contest emits no warning");

// Sweepstakes: no RST columns at all. Before this fix the same QSO emitted
// "... N0CALL 599 001 A 72 MN G3ABC 599 ..." — every field one column right.
const ssText = logbook.toCabrillo(cabBook("cab-ss", "ARRL-SS", [
  { date: "2026-11-07", time: "18:05", callsign: "k1xyz", mode: "CW",
    frequency: "7.040", band: "40m", rstSent: "599", rstReceived: "599",
    exchSent: "001 A 72 MN", exchRcvd: "014 B 65 EMA" },
]));
eq(header(ssText, "CONTEST"), "ARRL-SS-CW", "SS CW log gets ARRL-SS-CW");
eq(qsoLines(ssText)[0], "QSO:  7040 CW 2026-11-07 1805 N0CALL 001 A 72 MN K1XYZ 014 B 65 EMA",
   "SS QSO line omits both RST columns");
// The RST values are present on the QSO record, so this is a real suppression,
// not a vacuous pass on missing data.
assert(!qsoLines(ssText)[0].includes(" 599 "), "SS line contains no stray signal report");

// Field Day: no RST either, and the official keyword.
const fdText = logbook.toCabrillo(cabBook("cab-fd", "ARRL-FD", [
  { date: "2026-06-27", time: "19:00", callsign: "w1aw", mode: "SSB",
    frequency: "14.250", band: "20m", rstSent: "59", rstReceived: "59",
    exchSent: "2A MN", exchRcvd: "3A CT" },
]));
eq(header(fdText, "CONTEST"), "ARRL-FIELD-DAY", "Field Day header uses the official keyword");
eq(qsoLines(fdText)[0], "QSO: 14250 PH 2026-06-27 1900 N0CALL 2A MN W1AW 3A CT",
   "Field Day QSO line omits RST");

// VHF: band designator instead of kHz, and FM is its own mode code.
const vhfText = logbook.toCabrillo(cabBook("cab-vhf", "ARRL-VHF-JUN", [
  { date: "2026-06-13", time: "20:15", callsign: "k2abc", mode: "FM",
    frequency: "146.520", band: "2m", exchSent: "EN34", exchRcvd: "FN31" },
]));
eq(header(vhfText, "CONTEST"), "ARRL-VHF-JUN", "June VHF keyword");
eq(qsoLines(vhfText)[0], "QSO:   144 FM 2026-06-13 2015 N0CALL EN34 K2ABC FN31",
   "VHF line uses the 144 band designator and the FM mode code");
assert(!qsoLines(vhfText)[0].includes("146520"), "VHF line does not emit kHz");

// A contest-list addition end-to-end: NA Sprint has no RST (serial + name +
// state), and the keyword is mode-split. Proves the new exchange composes into
// real Cabrillo columns, not just that the keyword table resolves.
const sprintText = logbook.toCabrillo(cabBook("cab-sprint", "NA-SPRINT", [
  { date: "2026-02-08", time: "00:30", callsign: "k5zd", mode: "CW",
    frequency: "7.035", band: "40m", rstSent: "599", rstReceived: "599",
    exchSent: "001 Pat MN", exchRcvd: "042 Randy MA" },
]));
eq(header(sprintText, "CONTEST"), "NA-SPRINT-CW", "NA Sprint CW log gets NA-SPRINT-CW");
eq(qsoLines(sprintText)[0], "QSO:  7035 CW 2026-02-08 0030 N0CALL 001 Pat MN K5ZD 042 Randy MA",
   "NA Sprint QSO line omits RST and carries serial/name/state");
assert(!qsoLines(sprintText)[0].includes(" 599 "), "NA Sprint line contains no stray signal report");

// This-task additions, end-to-end. All Asian DX: RST + the two-digit age, both
// RST columns present, keyword AADX-CW.
const aaText = logbook.toCabrillo(cabBook("cab-aa", "AADX", [
  { date: "2026-06-20", time: "05:00", callsign: "ja1abc", mode: "CW",
    frequency: "14.020", band: "20m", rstSent: "599", rstReceived: "599",
    exchSent: "44", exchRcvd: "35" },
]));
eq(header(aaText, "CONTEST"), "AADX-CW", "All Asian DX CW log gets AADX-CW");
eq(qsoLines(aaText)[0], "QSO: 14020 CW 2026-06-20 0500 N0CALL 599 44 JA1ABC 599 35",
   "All Asian DX line carries both RST columns and the age exchange");

// WW Digi: 4-char grid only, no RST, FT8 -> DG mode code, kHz on 20m.
const digiText = logbook.toCabrillo(cabBook("cab-digi", "WW-DIGI", [
  { date: "2026-08-29", time: "12:00", callsign: "dl1abc", mode: "FT8",
    frequency: "14.074", band: "20m", rstSent: "599", rstReceived: "599",
    exchSent: "EN34", exchRcvd: "JO31" },
]));
eq(header(digiText, "CONTEST"), "WW-DIGI", "WW Digi log gets WW-DIGI");
eq(qsoLines(digiText)[0], "QSO: 14074 DG 2026-08-29 1200 N0CALL EN34 DL1ABC JO31",
   "WW Digi line omits RST, uses the DG mode code and the grid exchange");
assert(!qsoLines(digiText)[0].includes(" 599 "), "WW Digi line contains no stray signal report");

// WAE: RST + serial, RTTY leg has its own keyword.
const waeText = logbook.toCabrillo(cabBook("cab-wae", "WAE", [
  { date: "2026-11-14", time: "10:00", callsign: "g3abc", mode: "RTTY",
    frequency: "7.040", band: "40m", rstSent: "599", rstReceived: "599",
    exchSent: "007", exchRcvd: "012" },
]));
eq(header(waeText, "CONTEST"), "DARC-WAEDC-RTTY", "WAE RTTY log gets DARC-WAEDC-RTTY");
eq(qsoLines(waeText)[0], "QSO:  7040 RY 2026-11-14 1000 N0CALL 599 007 G3ABC 599 012",
   "WAE line carries both RST columns and the serial exchange");

// The legacy generic VHF id exports honestly: UNKNOWN plus a warning line.
const legacyText = logbook.toCabrillo(cabBook("cab-legacy", "VHF", [
  { date: "2026-06-13", time: "20:15", callsign: "k2abc", mode: "FM", band: "2m",
    exchSent: "EN34", exchRcvd: "FN31" },
]));
eq(header(legacyText, "CONTEST"), "UNKNOWN", "legacy VHF exports UNKNOWN, not a guess");
assert(header(legacyText, "X-WEBHAM-WARNING").length > 0, "legacy VHF export carries a warning line");

// toCabrillo must read the QSOs of the book it is given. This previously read
// the *active* logbook while taking the header from `book`, so exporting a
// non-active book produced the wrong QSOs under the right header.
const bookA = cabBook("cab-a", "IARU-HF", [
  { date: "2026-07-11", time: "12:00", callsign: "ja1abc", mode: "CW", band: "20m",
    frequency: "14.030", rstSent: "599", rstReceived: "599", exchSent: "8", exchRcvd: "45" },
]);
const bookB = cabBook("cab-b", "IARU-HF", [
  { date: "2026-07-11", time: "13:00", callsign: "vk3xyz", mode: "CW", band: "15m",
    frequency: "21.030", rstSent: "599", rstReceived: "599", exchSent: "8", exchRcvd: "59" },
]);
assert(logbook.toCabrillo(bookA).includes("JA1ABC"), "book A export contains book A's QSO");
assert(!logbook.toCabrillo(bookA).includes("VK3XYZ"), "book A export excludes book B's QSO");
assert(logbook.toCabrillo(bookB).includes("VK3XYZ"), "book B export contains book B's QSO");
assert(!logbook.toCabrillo(bookB).includes("JA1ABC"), "book B export excludes book A's QSO");

// QSOs come out in chronological order regardless of insertion order.
const orderText = logbook.toCabrillo(cabBook("cab-order", "IARU-HF", [
  { date: "2026-07-11", time: "13:00", callsign: "second", mode: "CW", band: "20m", frequency: "14.030" },
  { date: "2026-07-11", time: "11:00", callsign: "first", mode: "CW", band: "20m", frequency: "14.030" },
]));
assert(qsoLines(orderText)[0].includes("FIRST"), "QSO lines are sorted chronologically");

// An empty contest logbook still produces a well-formed (if unsubmittable) log.
const emptyText = logbook.toCabrillo(cabBook("cab-empty", "CQ-WW", []));
eq(qsoLines(emptyText).length, 0, "empty logbook emits no QSO lines");
assert(emptyText.endsWith("END-OF-LOG:\n"), "empty logbook is still terminated");

// ── cabrilloCategoryLines (entry-category headers, N1MM-style) ──────────────
const cat = (entry) => cabrilloCategoryLines(entry);
// A fully-specified entry emits every CATEGORY-* line plus score/operators/location.
const full = cat({
  operator: "SINGLE-OP", assisted: "ASSISTED", power: "LOW", band: "ALL",
  mode: "CW", transmitter: "ONE", station: "FIXED", overlay: "CLASSIC",
  claimedScore: "12345", operators: "n0call", location: "EMA",
});
eq(full.includes("CATEGORY-OPERATOR: SINGLE-OP"), true, "operator line");
eq(full.includes("CATEGORY-ASSISTED: ASSISTED"), true, "assisted line");
eq(full.includes("CATEGORY-POWER: LOW"), true, "power line");
eq(full.includes("CATEGORY-BAND: ALL"), true, "band line");
eq(full.includes("CATEGORY-MODE: CW"), true, "mode line");
eq(full.includes("CATEGORY-TRANSMITTER: ONE"), true, "transmitter line");
eq(full.includes("CATEGORY-STATION: FIXED"), true, "station line");
eq(full.includes("CATEGORY-OVERLAY: CLASSIC"), true, "overlay line");
eq(full.includes("CLAIMED-SCORE: 12345"), true, "claimed score line");
eq(full.includes("OPERATORS: N0CALL"), true, "operators upper-cased");
eq(full.includes("LOCATION: EMA"), true, "location upper-cased");

// The load-bearing rule: an UNSET category emits NO line — no false declaration.
eq(cat({}).length, 0, "empty entry emits zero header lines");
eq(cat({ power: "LOW" }).length, 1, "only the set category is emitted");
eq(cat({ power: "LOW" })[0], "CATEGORY-POWER: LOW", "the one set line is correct");
eq(cat(undefined).length, 0, "undefined entry is safe and emits nothing");

// A value outside the enumeration is dropped, not emitted — dropdowns constrain
// input, but the writer refuses a bad token defensively rather than shipping it.
eq(cat({ power: "SUPER" }).length, 0, "an out-of-enum category value is not emitted");
eq(cat({ operator: "single-op" })[0], "CATEGORY-OPERATOR: SINGLE-OP", "category value is normalised to upper-case");

// CLAIMED-SCORE must be a non-negative integer or it is omitted (a non-numeric
// score line gets a submitted log rejected).
eq(cat({ claimedScore: "0" }).includes("CLAIMED-SCORE: 0"), true, "zero score is valid");
eq(cat({ claimedScore: "12,345" }).length, 0, "a non-integer score is omitted");
eq(cat({ claimedScore: "abc" }).length, 0, "a non-numeric score is omitted");

// End-to-end: entry headers land in the exported log, after CALLSIGN, before QSOs.
const catText = logbook.toCabrillo({
  id: "cab-cat", name: "cab-cat", type: "contest",
  meta: { contest: "CQ-WW", entry: { operator: "SINGLE-OP", power: "LOW", assisted: "NON-ASSISTED", location: "EMA" } },
});
assert(/\nCATEGORY-OPERATOR: SINGLE-OP\n/.test(catText), "export carries CATEGORY-OPERATOR");
assert(/\nCATEGORY-POWER: LOW\n/.test(catText), "export carries CATEGORY-POWER");
assert(/\nLOCATION: EMA\n/.test(catText), "export carries LOCATION");
const catLines = catText.split("\n");
assert(catLines.indexOf("CALLSIGN: N0CALL") < catLines.indexOf("CATEGORY-OPERATOR: SINGLE-OP"),
  "category headers come after CALLSIGN");
// A contest logbook with no entry set exports no CATEGORY lines (regression: the
// pre-feature behaviour is preserved for logbooks that never set a category).
const noCatText = logbook.toCabrillo(cabBook("cab-nocat", "CQ-WW", []));
assert(!/CATEGORY-/.test(noCatText), "a logbook with no entry set emits no CATEGORY headers");

// Every catalog option is Cabrillo-legal (upper-case, digits, hyphen, dot).
for (const [key, def] of Object.entries(CABRILLO_CATEGORIES)) {
  for (const opt of def.options) {
    assert(/^[A-Z0-9.-]+$/.test(opt), `${key} option "${opt}" is a legal Cabrillo token`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
