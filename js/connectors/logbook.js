// Logbook connector — the store for logbooks and QSOs, plus ADIF and Cabrillo
// text generation. DOM-free; the logger mini-app owns every form and table.
//
// Events: "change" (a QSO was committed), "persist-failed" (the write did not
// reach disk — see persistQsos, which is the one failure that can lose a
// contact).
//
// Each logbook's QSOs live under their own localStorage key, so switching books
// does not rewrite the others. Contest exchanges are composed from a field
// catalog rather than hardcoded per contest — see EXCHANGE_FIELDS below.
import { settings, KEYS } from "./settings.js";
import { inferBandFromFrequency, parseFrequencyText, BAND_TO_KHZ } from "../utils.js";
import { GENERATED_CONTESTS } from "./contests-generated.js";

// Composable exchange system. A contest's sent/rcvd exchange is expressed as
// an ordered list of field keys drawn from EXCHANGE_FIELDS; the entry pad and
// create form render inputs from those keys, and the exchange strings are
// composed at save time (see composeExchange / nextSerial below).
//
// EXCHANGE_FIELDS is the reusable catalog of exchange elements. `label`/`ph`
// drive the rendered input; `auto` marks a field whose value comes from the
// QSO itself rather than a typed exchange input ("rst" = the signal report,
// "serial" = the auto-incrementing sent serial); `wide` fields want a wider
// input on the pad.
export const EXCHANGE_FIELDS = {
  rst:     { label: "RST",        ph: "59",   auto: "rst" },     // from the QSO signal-report field
  serial:  { label: "Nr",         ph: "001",  auto: "serial" },  // auto-increment sent serial
  cqzone:  { label: "CQ Zone",    ph: "5" },
  ituzone: { label: "ITU Zone",   ph: "8" },
  state:   { label: "State/Prov", ph: "MN" },
  section: { label: "ARRL Sect",  ph: "MN" },
  class:   { label: "Class",      ph: "1A" },
  prec:    { label: "Prec",       ph: "A" },      // ARRL SS precedence (Q/A/B/U/M/S)
  check:   { label: "Check",      ph: "72" },     // ARRL SS check — last 2 digits of first-licensed year
  name:    { label: "Name",       ph: "Pat", wide: true },
  age:     { label: "Age",        ph: "42" },
  power:   { label: "Power",      ph: "100" },
  grid:    { label: "Grid",       ph: "FN31" },
  text:    { label: "Exchange",   ph: "",     wide: true },
};

// `id` is WebHam's internal contest key, persisted in book.meta.contest. It is
// NOT the Cabrillo CONTEST: value — several contests need a mode suffix and one
// (ARRL-FD) has an entirely different official keyword, so the wire value is the
// per-row `cab` below. Ids stay frozen so existing logbooks keep resolving; only
// `cab` changes when sponsors rename a contest.
//
// `cab` is this table's single source of truth for the Cabrillo CONTEST: keyword
// (CABRILLO_KEYWORDS is DERIVED from it below — one row fully describes a
// contest, so importing more of N1MM's set is a data edit here, not a two-table
// edit). A string is a fixed keyword; `{ byMode }` needs a mode suffix keyed by
// the Cabrillo mode code the log maps to; `null` means "no keyword we can know"
// (the export then writes UNKNOWN + a warning rather than inventing one).
//
// Each contest also lists its `sent` and `rcvd` exchange field keys (display
// order) plus `me` — the subset of sent fields whose value is FIXED per-logbook
// (configured at logbook creation). `rst`/`serial` are auto (never in `me`).
// Whether "rst" appears here is load-bearing: the Cabrillo QSO line emits RST
// columns only for contests that actually exchange a signal report, so adding
// or removing "rst" changes the exported column layout.
// `serial`/`exch` are derived below for backward compatibility.
export const CONTESTS = [
  { id: "CQ-WW",      name: "CQ WW DX",              sent: ["rst", "cqzone"],          rcvd: ["rst", "cqzone"],          me: ["cqzone"],           cab: { byMode: { CW: "CQ-WW-CW", PH: "CQ-WW-SSB" } } },
  { id: "CQ-WPX",     name: "CQ WPX",               sent: ["rst", "serial"],          rcvd: ["rst", "serial"],          me: [],                   cab: { byMode: { CW: "CQ-WPX-CW", PH: "CQ-WPX-SSB", RY: "CQ-WPX-RTTY" } } },
  { id: "ARRL-DX",    name: "ARRL DX (US side)",    sent: ["rst", "state"],           rcvd: ["rst", "power"],           me: ["state"],            cab: { byMode: { CW: "ARRL-DX-CW", PH: "ARRL-DX-SSB" } } },
  { id: "ARRL-FD",    name: "ARRL Field Day",       sent: ["class", "section"],       rcvd: ["class", "section"],       me: ["class", "section"], cab: "ARRL-FIELD-DAY" },
  { id: "ARRL-10",    name: "ARRL 10 Meter",        sent: ["rst", "state"],           rcvd: ["rst", "state"],           me: ["state"],            cab: "ARRL-10" },
  // SS sends serial + precedence + check + section, and no signal report. The
  // station's own prec/check/section are fixed for the whole log; only the
  // serial advances, so `me` carries the three fixed elements.
  { id: "ARRL-SS",    name: "ARRL Sweepstakes",     sent: ["serial", "prec", "check", "section"], rcvd: ["serial", "prec", "check", "section"], me: ["prec", "check", "section"], cab: { byMode: { CW: "ARRL-SS-CW", PH: "ARRL-SS-SSB" } } },
  { id: "NAQP",       name: "NAQP",                 sent: ["name", "state"],          rcvd: ["name", "state"],          me: ["name", "state"],    cab: { byMode: { CW: "NAQP-CW", PH: "NAQP-SSB", RY: "NAQP-RTTY" } } },
  { id: "IARU-HF",    name: "IARU HF Championship", sent: ["rst", "ituzone"],         rcvd: ["rst", "ituzone"],         me: ["ituzone"],          cab: "IARU-HF" },
  { id: "CQ-WW-RTTY", name: "CQ WW RTTY",           sent: ["rst", "cqzone", "state"], rcvd: ["rst", "cqzone", "state"], me: ["cqzone", "state"],  cab: "CQ-WW-RTTY" },
  // Additions toward N1MM's supported-contest set. Every `cab` keyword is
  // cross-checked against the sponsor's own Cabrillo/rules page via WebSearch
  // (the canonical WA7BNM/N1MM list is blocked by this session's egress policy —
  // see the PR). Where an exchange does not map cleanly onto the field catalog
  // (a single slot that is a state for W/VE but a serial for DX, a JA prefecture,
  // WAE's QTC traffic) the row uses the freeform `text` field rather than
  // modelling it wrongly — the keyword is what a log checker rejects, and that is
  // verified; the freeform slot still round-trips the operator's typed exchange.
  //
  // CQ 160: RS(T) + state (W) / province (VE) / CQ zone (DX). The single
  // state/prov slot holds the DX zone too — region-varying like ARRL-10.
  { id: "CQ-160",     name: "CQ 160-Meter",         sent: ["rst", "state"],           rcvd: ["rst", "state"],           me: ["state"],            cab: { byMode: { CW: "CQ-160-CW", PH: "CQ-160-SSB" } } },
  // NA Sprint: serial + name + location (state/prov/country). Name and location
  // are fixed per operator; the serial advances.
  { id: "NA-SPRINT",  name: "NA Sprint",            sent: ["serial", "name", "state"], rcvd: ["serial", "name", "state"], me: ["name", "state"],  cab: { byMode: { CW: "NA-SPRINT-CW", PH: "NA-SPRINT-SSB" } } },
  // Scandinavian Activity Contest and Oceania DX: RST + serial, the standard
  // serialised-DX exchange.
  { id: "SAC",        name: "Scandinavian Activity", sent: ["rst", "serial"],         rcvd: ["rst", "serial"],          me: [],                   cab: { byMode: { CW: "SAC-CW", PH: "SAC-SSB" } } },
  { id: "OCEANIA-DX", name: "Oceania DX",           sent: ["rst", "serial"],          rcvd: ["rst", "serial"],          me: [],                   cab: { byMode: { CW: "OCEANIA-DX-CW", PH: "OCEANIA-DX-SSB" } } },
  // ARRL 160: RS(T) + ARRL/RAC section (W/VE); DX send RST only (blank slot).
  { id: "ARRL-160",   name: "ARRL 160-Meter",       sent: ["rst", "section"],         rcvd: ["rst", "section"],         me: ["section"],          cab: "ARRL-160" },
  // Grid-only exchanges, same shape as the ARRL VHF runnings.
  { id: "STEW-PERRY", name: "Stew Perry Topband",   sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "STEW-PERRY" },
  { id: "ARRL-UHF-AUG", name: "ARRL August UHF",    sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "ARRL-UHF-AUG" },
  { id: "CQ-VHF",     name: "CQ WW VHF",            sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "CQ-VHF" },
  // The ARRL VHF runnings share one exchange (grid) but each has its own
  // Cabrillo keyword, so they are separate contests rather than one "VHF".
  { id: "ARRL-VHF-JAN", name: "ARRL January VHF",   sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "ARRL-VHF-JAN" },
  { id: "ARRL-VHF-JUN", name: "ARRL June VHF",      sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "ARRL-VHF-JUN" },
  { id: "ARRL-VHF-SEP", name: "ARRL September VHF", sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "ARRL-VHF-SEP" },
  // ── More of N1MM's set (this task). Keywords cross-checked via WebSearch: ──
  // ARRL RTTY Roundup — W/VE send RS(T)+state/prov, DX send RS(T)+serial; the
  // one exchange slot is region-varying, so `text`. Keyword: ARRL-RTTY.
  { id: "ARRL-RTTY",  name: "ARRL RTTY Roundup",    sent: ["rst", "text"],            rcvd: ["rst", "text"],            me: [],                   cab: "ARRL-RTTY" },
  // JARL All Asian DX — RS(T) + the operator's own two-digit age (symmetric, so
  // your age is fixed per log). Keywords: AADX-CW / AADX-SSB.
  { id: "AADX",       name: "JARL All Asian DX",    sent: ["rst", "age"],             rcvd: ["rst", "age"],             me: ["age"],              cab: { byMode: { CW: "AADX-CW", PH: "AADX-SSB" } } },
  // Japan Int'l DX — non-JA send RS(T)+CQ zone, JA send RS(T)+prefecture number;
  // the received value depends on the other station's region, so `text`.
  { id: "JIDX",       name: "Japan International DX", sent: ["rst", "text"],          rcvd: ["rst", "text"],            me: [],                   cab: { byMode: { CW: "JIDX-CW", PH: "JIDX-SSB" } } },
  // Russian DX — one keyword regardless of mode (mixed modes score as one log);
  // DX send RS(T)+serial, RU send RS(T)+RDA oblast, so the slot is `text`.
  { id: "RDXC",       name: "Russian DX",           sent: ["rst", "text"],            rcvd: ["rst", "text"],            me: [],                   cab: "RDXC" },
  // WAE DX (DARC) — RS(T) + serial. QTC traffic is a separate scoring mechanism
  // WebHam does not model; the QSO exchange itself is the standard serial.
  { id: "WAE",        name: "WAE DX (DARC)",        sent: ["rst", "serial"],          rcvd: ["rst", "serial"],          me: [],                   cab: { byMode: { CW: "DARC-WAEDC-CW", PH: "DARC-WAEDC-SSB", RY: "DARC-WAEDC-RTTY" } } },
  // WW Digi (WWROF/SCC) — 4-char grid only, FT4/FT8; one mode-agnostic keyword.
  { id: "WW-DIGI",    name: "WW Digi DX",           sent: ["grid"],                   rcvd: ["grid"],                   me: ["grid"],             cab: "WW-DIGI" },
  // Legacy: logbooks created before the VHF runnings were split still carry
  // meta.contest === "VHF". Kept so their entry pad keeps rendering the grid
  // field; `cab: null` because which running it was is not recorded anywhere and
  // must not be guessed (the export warns and names the runnings to pick from).
  { id: "VHF",        name: "VHF (legacy — reselect running)", sent: ["grid"],         rcvd: ["grid"],                   me: ["grid"],             cab: null },
  { id: "OTHER",      name: "Other / Custom",       sent: ["rst", "text"],            rcvd: ["rst", "text"],            me: [],                   cab: null },
];
// Augment the hand-modelled majors above with the generated long tail of N1MM's
// supported set (contests-generated.js, built by tools/sync-contests.mjs from
// the WA7BNM + N1MM sources). The generator omits any keyword already modelled
// here, so no duplicates. Inserted before the VHF-legacy / OTHER sentinels so
// those stay last in the contest picker, and before the derivations below so
// the generated rows get the same serial/exch/keyword treatment.
// The hand-modelled subset, captured BEFORE augmentation. tools/sync-contests.mjs
// reads this to know which keywords/ids it must NOT generate — reading the merged
// CONTESTS instead would be a feedback loop (the generator would see its own
// previous output as "already covered" and emit nothing).
export const CORE_CONTESTS = CONTESTS.slice();
CONTESTS.splice(CONTESTS.length - 2, 0, ...GENERATED_CONTESTS);
// Backward-compat derived fields so pre-composable callers keep working:
// `serial` = does the sent exchange auto-number; `exch` = a human label for
// the received exchange (non-RST field labels, joined).
CONTESTS.forEach((c) => {
  c.serial = c.sent.includes("serial");
  c.exch = c.rcvd.filter((k) => k !== "rst").map((k) => EXCHANGE_FIELDS[k]?.label || k).join(" + ") || "Exchange";
});

// Pure helper: join the non-empty values of `fieldKeys` (in order) into a
// space-separated exchange string. Unit-testable, no DOM/state.
export function composeExchange(fieldKeys, valuesByKey) {
  return (fieldKeys || [])
    .map((k) => (valuesByKey?.[k] ?? "").toString().trim())
    .filter((v) => v !== "")
    .join(" ");
}

// Next sent serial for a contest logbook, zero-padded to 3 digits.
//
// Derived from the highest serial already issued, NOT from the QSO count: serial
// numbers are sent over the air and must never be reused, but a count-based
// serial goes backwards the moment a QSO is deleted (log 5, delete one, and the
// next QSO re-sends 005 — a dupe in the submitted log). Legacy books whose QSOs
// carry no recorded serial fall back to the count so numbering still advances.
export function nextSerial(book) {
  const qsos = loadQsos(book.id);
  let highest = 0;
  let seen = false;
  qsos.forEach((q) => {
    const raw = q?.exchFields?.sent?.serial;
    if (raw === undefined || raw === null || raw === "") return;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return;
    seen = true;
    if (n > highest) highest = n;
  });
  const next = seen ? highest + 1 : qsos.length + 1;
  return String(next).padStart(3, "0");
}
export const LOGBOOK_TYPE_LABELS = { general: "General", pota: "POTA", sota: "SOTA", contest: "Contest" };
export const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia"
};

export const PARK_REF_RE = /^[A-Z]{1,3}-\d{3,5}$/;
export const SUMMIT_REF_RE = /^[A-Z0-9]{1,8}\/[A-Z]{2}-\d{3}$/;

const storageKey = "web-ham-logger.qsos"; // legacy single-log key; migrated into a logbook on boot

function qsoStorageKey(logbookId) {
  return `${storageKey}.${logbookId}`;
}

function makeLogbook(name, type, meta) {
  return {
    id: crypto.randomUUID(),
    name,
    type, // "general" | "pota" | "sota" | "contest"
    createdAt: new Date().toISOString(),
    meta: meta || {}
  };
}

// Load the logbook registry; on first run, migrate the legacy single log
// into a default "Station Logbook".
function initLogbooks() {
  let logbooks = null;
  try {
    logbooks = JSON.parse(localStorage.getItem(KEYS.LOGBOOKS_KEY) || "null");
  } catch {
    logbooks = null;
  }
  if (Array.isArray(logbooks) && logbooks.length > 0) return logbooks;

  const def = makeLogbook("Station Logbook", "general");
  const legacy = localStorage.getItem(storageKey);
  if (legacy) {
    localStorage.setItem(qsoStorageKey(def.id), legacy);
    localStorage.removeItem(storageKey);
  }
  logbooks = [def];
  localStorage.setItem(KEYS.LOGBOOKS_KEY, JSON.stringify(logbooks));
  localStorage.setItem(KEYS.ACTIVE_LOGBOOK_KEY, def.id);
  return logbooks;
}

function persistLogbooks() {
  localStorage.setItem(KEYS.LOGBOOKS_KEY, JSON.stringify(logbooksArr));
}

function loadQsos(logbookId) {
  try {
    return JSON.parse(localStorage.getItem(qsoStorageKey(logbookId)) || "[]");
  } catch {
    return [];
  }
}

// Every write of the QSO list goes through here — commit(), persist(),
// deleteQso(), replaceQsos().
//
// This used to be a bare setItem with no error handling, which is the worst
// place in a logger to have one. localStorage is a few megabytes and throws
// QuotaExceededError when full; a long contest log plus everything else WebHam
// stores can reach that. The throw propagated out of commit() into the logger's
// async submit handler, where it became an unhandled rejection: the form
// cleared, the QSO sat in the in-memory array looking saved, and it was gone on
// the next reload. A contact lost with no error shown is not acceptable.
//
// Now the failure is reported. The in-memory array still holds the QSO, so the
// operator can see it and export ADIF to get it out — losing it quietly was the
// real damage, not the failed write.
function persistQsos() {
  try {
    localStorage.setItem(qsoStorageKey(activeLogbookId), JSON.stringify(qsosArr));
    return true;
  } catch (error) {
    console.error("[WebHam] could not save the logbook", error);
    logbook.dispatchEvent(new CustomEvent("persist-failed", {
      detail: error?.name === "QuotaExceededError"
        ? "Browser storage is full — this contact is in the log on screen but NOT saved to disk. "
        + "Export ADIF now, then delete an old logbook to free space."
        : `Could not save the logbook (${error?.message || error}). Export ADIF to be safe.`,
    }));
    return false;
  }
}

export function contestFor(book) {
  return CONTESTS.find((c) => c.id === book?.meta?.contest) || null;
}

// Cabrillo 3.0 mode codes: CW, PH, FM, RY, DG. FM is its own code, NOT a kind
// of PH — VHF/UHF log checkers score FM contacts separately, so folding FM into
// PH mislabels every repeater/simplex QSO.
function cabrilloMode(mode) {
  const m = (mode || "").toUpperCase();
  if (m === "CW") return "CW";
  if (m === "FM") return "FM";
  if (["SSB", "USB", "LSB", "AM"].includes(m)) return "PH";
  if (m === "RTTY") return "RY";
  return "DG";
}

// Cabrillo band designators for VHF and up. Above 50 MHz the QSO line carries a
// band designator rather than a frequency in kHz, so a 2m contact is "144", not
// "144000". Only the bands BAND_PLAN can actually produce are listed.
const CABRILLO_BAND = { "6m": "50", "2m": "144", "70cm": "432" };

// The official Cabrillo CONTEST: keyword per internal contest id, DERIVED from
// each contest's `cab` field (CONTESTS is the single source of truth — see the
// note there). Enumerated, never pattern-derived: the previous code guessed with
// a "mode-split contests" rule that got three wrong — it fabricated ARRL-10-CW
// (ARRL 10 Meter is one mode-agnostic keyword), emitted a bare ARRL-SS (never
// valid — SS is always suffixed), and passed ARRL-FD straight through (the
// keyword is ARRL-FIELD-DAY). A string value is a fixed keyword; a `byMode` value
// needs a mode suffix keyed by the Cabrillo mode code the log's QSOs map to;
// `null` means "no valid keyword exists for this id" — the export then emits
// UNKNOWN plus a warning line rather than inventing something a log checker would
// reject. `?? null` folds a row that forgot `cab` into the honest-UNKNOWN path.
const CABRILLO_KEYWORDS = Object.fromEntries(CONTESTS.map((c) => [c.id, c.cab ?? null]));

// Resolve the Cabrillo CONTEST: keyword for a contest id and its logged QSOs.
// Returns { keyword, warning }: `keyword` is always a string safe to write into
// the header ("UNKNOWN" when unresolvable), and `warning` is a human-readable
// reason when it could not be resolved, so the caller can surface it instead of
// shipping a silently-wrong log. Pure and null-safe.
export function cabrilloContestKeyword(contestId, qsos) {
  const entry = contestId ? CABRILLO_KEYWORDS[contestId] : undefined;
  if (typeof entry === "string") return { keyword: entry, warning: "" };
  if (entry === null) {
    return {
      keyword: "UNKNOWN",
      warning: contestId === "VHF"
        ? "This logbook predates the ARRL VHF split and does not record which running it was. Create a logbook for ARRL January/June/September VHF and set CONTEST: by hand before submitting."
        : `No official Cabrillo keyword is defined for "${contestId}". Set CONTEST: by hand before submitting.`,
    };
  }
  if (!entry) {
    return { keyword: "UNKNOWN", warning: `Unrecognised contest "${contestId || ""}". Set CONTEST: by hand before submitting.` };
  }
  // Mode-suffixed contest: the suffix comes from the modes actually logged. A
  // log spanning two modes is two different contests as far as sponsors are
  // concerned, so refuse to pick rather than mislabelling half the QSOs.
  const modes = new Set((qsos || []).map((q) => cabrilloMode(q?.mode)));
  if (modes.size === 1) {
    const only = [...modes][0];
    if (entry.byMode[only]) return { keyword: entry.byMode[only], warning: "" };
    return { keyword: "UNKNOWN", warning: `${contestId} has no ${only} category. Set CONTEST: by hand before submitting.` };
  }
  const valid = Object.values(entry.byMode).join(", ");
  return {
    keyword: "UNKNOWN",
    warning: modes.size === 0
      ? `Cannot pick between ${valid} with no QSOs logged. Set CONTEST: by hand before submitting.`
      : `This log mixes modes, but ${contestId} is scored as separate contests (${valid}). Export one mode per logbook, or set CONTEST: by hand.`,
  };
}

// Cabrillo 3.0 entry-category headers, N1MM-style. Each CATEGORY-* value is a
// constrained enumeration; the create-logbook form renders these as dropdowns so
// an invalid token can't be typed, and cabrilloCategoryLines() emits a header
// ONLY for a value the operator explicitly picked. A blank stays blank — an
// unset category emits no line rather than a defaulted (and possibly false)
// declaration. `options` are the wire values; `label` names the header line.
export const CABRILLO_CATEGORIES = {
  operator:    { header: "CATEGORY-OPERATOR",    label: "Operator",    options: ["SINGLE-OP", "MULTI-OP", "CHECKLOG"] },
  assisted:    { header: "CATEGORY-ASSISTED",    label: "Assisted",    options: ["ASSISTED", "NON-ASSISTED"] },
  power:       { header: "CATEGORY-POWER",       label: "Power",       options: ["HIGH", "LOW", "QRP"] },
  band:        { header: "CATEGORY-BAND",        label: "Band",        options: ["ALL", "160M", "80M", "40M", "20M", "15M", "10M", "6M", "2M", "222", "432", "902", "1.2G"] },
  mode:        { header: "CATEGORY-MODE",        label: "Mode",        options: ["CW", "SSB", "RTTY", "FM", "DIGI", "MIXED"] },
  transmitter: { header: "CATEGORY-TRANSMITTER", label: "Transmitter", options: ["ONE", "TWO", "LIMITED", "UNLIMITED", "SWL"] },
  station:     { header: "CATEGORY-STATION",     label: "Station",     options: ["FIXED", "MOBILE", "PORTABLE", "ROVER", "EXPEDITION", "HQ", "SCHOOL", "DISTRIBUTED"] },
  overlay:     { header: "CATEGORY-OVERLAY",     label: "Overlay",     options: ["CLASSIC", "ROOKIE", "TB-WIRES", "YOUTH", "NOVICE-TECH", "YL"] },
};

// Pure: turn a logbook's entry-category selections (book.meta.entry) into the
// Cabrillo header lines. Emits a CATEGORY-* line only for a recognised, set
// value; LOCATION and OPERATORS when non-empty; CLAIMED-SCORE only when it is a
// non-negative integer (a stray non-numeric score line gets a log rejected).
// Exported for unit testing.
export function cabrilloCategoryLines(entry) {
  const e = entry || {};
  const lines = [];
  for (const [key, def] of Object.entries(CABRILLO_CATEGORIES)) {
    const v = (e[key] || "").toString().trim().toUpperCase();
    if (v && def.options.includes(v)) lines.push(`${def.header}: ${v}`);
  }
  const score = (e.claimedScore ?? "").toString().trim();
  if (/^\d+$/.test(score)) lines.push(`CLAIMED-SCORE: ${score}`);
  const operators = (e.operators || "").toString().trim().toUpperCase();
  if (operators) lines.push(`OPERATORS: ${operators}`);
  const location = (e.location || "").toString().trim().toUpperCase();
  if (location) lines.push(`LOCATION: ${location}`);
  return lines;
}

// The Cabrillo QSO: frequency column is a band designator above 50 MHz and a
// frequency in kHz below it.
function cabrilloFreq(qso) {
  const band = (qso.band || "").toLowerCase();
  if (CABRILLO_BAND[band]) return CABRILLO_BAND[band];
  const hz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
  return String(hz ? Math.round(hz / 1000) : BAND_TO_KHZ[band] || 0);
}

// Render one logbook as Cabrillo 3.0 text. Reads the QSOs of the book it was
// handed — not the active logbook — so exporting a non-active book emits that
// book's contacts under that book's header.
function generateCabrilloText(book) {
  const s = settings.get();
  const myCall = (s.stationCall || "UNKNOWN").toUpperCase();
  const contest = contestFor(book);
  const qsos = loadQsos(book.id);
  const { keyword, warning } = cabrilloContestKeyword(contest?.id, qsos);
  const lines = [
    "START-OF-LOG: 3.0",
    `CONTEST: ${keyword}`,
    `CALLSIGN: ${myCall}`,
    "CREATED-BY: WebHam"
  ];
  // Entry-category headers (CATEGORY-* / CLAIMED-SCORE / OPERATORS / LOCATION),
  // only for values the operator set on this logbook. Placed after CALLSIGN,
  // the conventional position, and before the QSO lines.
  lines.push(...cabrilloCategoryLines(book.meta?.entry));
  // X- tags are the spec's own extension space, so an unresolved keyword travels
  // with the log (visible to whoever opens the file) without breaking parsers.
  if (warning) lines.push(`X-WEBHAM-WARNING: ${warning}`);
  if (s.ft8MyGrid) lines.push(`GRID-LOCATOR: ${s.ft8MyGrid.toUpperCase()}`);
  // RST columns belong in the QSO line only for contests whose exchange carries
  // a signal report. SS, Field Day, NAQP and the VHF contests do not exchange
  // one; emitting "599" anyway shifts every following column one position right
  // and gets the whole log rejected.
  const sendsRst = (contest?.sent || ["rst"]).includes("rst");
  const rcvdRst = (contest?.rcvd || ["rst"]).includes("rst");
  const sorted = [...qsos].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  sorted.forEach((qso) => {
    const mo = cabrilloMode(qso.mode);
    const time = (qso.time || "").replace(":", "").slice(0, 4);
    const defRst = mo === "PH" || mo === "FM" ? "59" : "599";
    const cols = ["QSO:", cabrilloFreq(qso).padStart(5), mo, qso.date, time, myCall];
    if (sendsRst) cols.push(qso.rstSent || defRst);
    cols.push(qso.exchSent || book.meta?.exchSent || "--");
    cols.push((qso.callsign || "").toUpperCase());
    if (rcvdRst) cols.push(qso.rstReceived || defRst);
    cols.push(qso.exchRcvd || "--");
    lines.push(cols.join(" "));
  });
  lines.push("END-OF-LOG:");
  return lines.join("\n") + "\n";
}

// `only` restricts the export to a subset of the active logbook. The LoTW
// upload passes the QSOs it has not already sent, so a station that logs
// daily uploads the day rather than its whole history every time.
function generateAdifText(only) {
  const s = settings.get();
  const stationCall = s.stationCall || "UNKNOWN";
  const myGrid = s.ft8MyGrid || "";
  const book = logbook.active();
  const myRef = (book?.meta?.ref || "").toUpperCase();
  let adif = `Generated by WebHam Logger\n<ADIF_VER:5>3.1.4\n<PROGRAMID:6>WebHam\n<EOH>\n`;
  (only || qsosArr).forEach(qso => {
    const qsoDate = (qso.date || "").replace(/-/g, "");
    const timeOn = (qso.time || "").replace(/:/g, "").padEnd(4, "0").slice(0, 4) + "00";
    const theirRef = (qso.theirRef || "").toUpperCase();
    const fields = [
      ["CALL", qso.callsign],
      ["QSO_DATE", qsoDate],
      ["TIME_ON", timeOn],
      ["BAND", qso.band],
      ["MODE", qso.mode],
      ["FREQ", qso.frequency ? String(parseFrequencyText(qso.frequency) / 1e6) : ""],
      ["RST_SENT", qso.rstSent],
      ["RST_RCVD", qso.rstReceived],
      ["GRIDSQUARE", qso.gridSquare],
      ["STATION_CALLSIGN", stationCall],
      ["MY_GRIDSQUARE", myGrid],
      ["TX_PWR", qso.power],
      ["NOTES", qso.notes]
    ];
    if (book?.type === "pota") {
      // pota.app-compatible activation fields
      if (myRef) fields.push(["MY_SIG", "POTA"], ["MY_SIG_INFO", myRef]);
      if (theirRef) fields.push(["SIG", "POTA"], ["SIG_INFO", theirRef]);
    } else if (book?.type === "sota") {
      if (myRef) fields.push(["MY_SOTA_REF", myRef]);
      if (theirRef) fields.push(["SOTA_REF", theirRef]);
    }
    if (qso.exchSent) fields.push(["STX_STRING", qso.exchSent]);
    if (qso.exchRcvd) fields.push(["SRX_STRING", qso.exchRcvd]);
    fields.forEach(([name, value]) => {
      if (value) {
        const val = String(value).trim();
        adif += `<${name.toUpperCase()}:${val.length}>${val} `;
      }
    });
    adif += "<EOR>\n";
  });
  return adif;
}

// Boot: seeds the store at module-eval time, same timing the monolith's top-level
// `const bootLogbooks = initLogbooks(); const bootActiveLogbookId = ...`
// used to run.
const bootLogbooks = initLogbooks();
const bootActiveLogbookId = (() => {
  const saved = localStorage.getItem(KEYS.ACTIVE_LOGBOOK_KEY);
  return bootLogbooks.some((b) => b.id === saved) ? saved : bootLogbooks[0].id;
})();

let logbooksArr = bootLogbooks;
let activeLogbookId = bootActiveLogbookId;
let qsosArr = loadQsos(activeLogbookId);

export const logbook = Object.assign(new EventTarget(), {
  list() {
    return logbooksArr;
  },

  active() {
    return logbooksArr.find((b) => b.id === activeLogbookId) || null;
  },

  // Switches the active logbook. Returns false (no-op) if `id` isn't a
  // known logbook, mirroring the guard at the top of the old openLogbook.
  open(id) {
    if (!logbooksArr.some((b) => b.id === id)) return false;
    activeLogbookId = id;
    localStorage.setItem(KEYS.ACTIVE_LOGBOOK_KEY, id);
    qsosArr = loadQsos(id);
    logbook.dispatchEvent(new CustomEvent("logbooks-change"));
    return true;
  },

  create(name, type, meta) {
    const book = makeLogbook(name, type, meta);
    logbooksArr.push(book);
    persistLogbooks();
    logbook.dispatchEvent(new CustomEvent("logbooks-change"));
    return book;
  },

  // Deviation (not in the original method list): delete a logbook and all
  // its QSOs. Moved verbatim from the delete-logbook branch of the monolith's
  // handleLogbookListClick, minus the confirm() dialog and re-render calls
  // (UI lives in js/apps/logger/index.js's own handleLogbookListClick,
  // Returns true if the deleted logbook was active
  // (i.e. the caller must re-apply the logbook UI / re-render QSOs).
  remove(id) {
    localStorage.removeItem(qsoStorageKey(id));
    logbooksArr = logbooksArr.filter((b) => b.id !== id);
    if (logbooksArr.length === 0) logbooksArr = [makeLogbook("Station Logbook", "general")];
    persistLogbooks();
    let switchedActive = false;
    if (activeLogbookId === id) {
      activeLogbookId = logbooksArr[0].id;
      localStorage.setItem(KEYS.ACTIVE_LOGBOOK_KEY, activeLogbookId);
      qsosArr = loadQsos(activeLogbookId);
      switchedActive = true;
    }
    logbook.dispatchEvent(new CustomEvent("logbooks-change"));
    return switchedActive;
  },

  // Deviation: per-logbook QSO list/count without switching the active
  // logbook. Moved from renderLogbookList's inline
  // `book.id === state.activeLogbookId ? state.qsos.length : loadQsos(book.id).length`.
  qsosFor(id) {
    return id === activeLogbookId ? qsosArr : loadQsos(id);
  },

  qsos() {
    return qsosArr;
  },

  // Adds a new QSO and dispatches "change". This is the only method that
  // dispatches "change" — js/apps/logger/index.js's listener (moved from
  // the connector) mirrors the exact UI tail the old commitQso() ran
  // after `state.qsos.push(qso); persistQsos();`.
  commit(qso) {
    qsosArr.push(qso);
    persistQsos();
    logbook.dispatchEvent(new CustomEvent("change", { detail: { qso } }));
  },

  findById(id) {
    return qsosArr.find((q) => q.id === id) || null;
  },

  // Dupe: same callsign + band + mode + same UTC day. Warning only, never blocks.
  findDupe(callsign, band, mode, date, excludeId = null) {
    const call = (callsign || "").trim().toUpperCase();
    if (!call || !band || !mode) return null;
    return qsosArr.find((q) =>
      q.id !== excludeId &&
      (q.callsign || "").toUpperCase() === call &&
      (q.band || logbook.qsoBand(q)) === band &&
      (q.mode || "").toUpperCase() === (mode || "").toUpperCase() &&
      q.date === date
    ) || null;
  },

  // Band for a QSO record: stored band, else derived from its frequency.
  qsoBand(qso) {
    if (qso.band) return qso.band;
    const hz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
    return hz ? inferBandFromFrequency(hz) : "";
  },

  // Deviation: persists the current qsos array as-is. Used where a caller
  // mutates a QSO object obtained via findById()/qsos() in place (inline
  // edit, form edit-existing, mark-sent toggle, LoTW sign/sync) and then
  // needs to flush to localStorage — mirrors the old bare persistQsos()
  // calls at those sites, which had no other side effects.
  persist() {
    persistQsos();
  },

  // Deviation: removes a QSO by id. Moved from the two direct
  // `state.qsos = state.qsos.filter(...); persistQsos();` sites (the
  // delete-contact form button and the table row delete button).
  deleteQso(id) {
    qsosArr = qsosArr.filter((q) => q.id !== id);
    persistQsos();
  },

  // Deviation: wholesale replace of the active logbook's QSOs. Moved from
  // importQsos' `state.qsos = parsed; persistQsos();`.
  replaceQsos(qsos) {
    qsosArr = qsos;
    persistQsos();
  },

  toAdif(only) {
    return generateAdifText(only);
  },

  toCabrillo(book) {
    return generateCabrilloText(book);
  },

  parseAdif(text) {
    const records = [];
    const headerSplit = text.split(/<EOH>/i);
    const data = headerSplit.length > 1 ? headerSplit[1] : text;
    const rawRecords = data.split(/<EOR>/i);

    for (const raw of rawRecords) {
      const record = {};
      const fieldRegex = /<([^:]+):(\d+)(?::[^>]*)?>([^<]*)/gi;
      let match;
      while ((match = fieldRegex.exec(raw)) !== null) {
        const fieldName = match[1].toUpperCase();
        const length = parseInt(match[2], 10);
        const value = match[3].substring(0, length);
        record[fieldName] = value;
      }
      if (Object.keys(record).length > 0) {
        records.push(record);
      }
    }
    return records;
  },

  // Matches a LoTW record against the local log. `excludeIds` lets the
  // caller (js/apps/logger/index.js's downloadLotwAdif) accumulate already-
  // matched QSO ids across a sync loop so two LoTW records can't both
  // resolve to the same logged QSO (main@100e8e0).
  findMatchingQso(lotwRecord, excludeIds = new Set()) {
    const lotwCall = (lotwRecord.CALL || "").trim().toUpperCase();
    const lotwBand = (lotwRecord.BAND || "").trim().toUpperCase();
    const lotwMode = (lotwRecord.MODE || "").trim().toUpperCase();
    const lotwDate = (lotwRecord.QSO_DATE || "").replace(/-/g, "");
    const lotwTime = (lotwRecord.TIME_ON || "").replace(/:/g, "").slice(0, 4);

    return qsosArr.find(qso => {
      if (excludeIds.has(qso.id)) return false;

      const qsoCall = (qso.callsign || "").trim().toUpperCase();
      const qsoBandVal = (qso.band || "").trim().toUpperCase();
      const qsoMode = (qso.mode || "").trim().toUpperCase();
      const qsoDate = (qso.date || "").replace(/-/g, "");
      const qsoTime = (qso.time || "").replace(/:/g, "").slice(0, 4);

      if (qsoCall !== lotwCall) return false;
      if (qsoBandVal !== lotwBand) return false;

      // Mode matching can be tricky
      const modesMatch = qsoMode === lotwMode ||
                         (qsoMode === "FT8" && lotwMode === "DATA") ||
                         (qsoMode === "FT4" && lotwMode === "DATA");
      if (!modesMatch) return false;

      if (qsoDate !== lotwDate) return false;

      // Time matching (within 15 minutes)
      const lotwMin = parseInt(lotwTime.slice(0, 2)) * 60 + parseInt(lotwTime.slice(2, 4));
      const qsoMin = parseInt(qsoTime.slice(0, 2)) * 60 + parseInt(qsoTime.slice(2, 4));
      if (isNaN(lotwMin) || isNaN(qsoMin) || Math.abs(lotwMin - qsoMin) > 15) return false;

      return true;
    });
  },
});
