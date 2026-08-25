#!/usr/bin/env node
// Regenerate contests.js from published sources, deterministically.
//
//   node tools/sync-contests.mjs --refresh   fetch the sources, rewrite the snapshot, report drift
//   node tools/sync-contests.mjs --build     snapshot + map -> contests.js          (offline)
//   node tools/sync-contests.mjs --check     rebuild and diff against contests.js   (offline)
//
// Three files, three jobs:
//
//   contest-sources.json  every fact we use, exactly as the source pages state
//                         it. Nothing in contests.js is invented — if a name or
//                         exchange is not in here, the build cannot emit it, and
//                         --refresh rewrites this file straight from the network,
//                         so a wrong value shows up as a diff against the source.
//
//   contest-map.json      which Cabrillo keyword corresponds to which N1MM
//                         contest. The two sites often name the same contest
//                         differently, so ~40% of these were decided by hand;
//                         freezing them here means they are reviewed once and
//                         then re-applied mechanically forever.
//
//   contests.js           generated. Do not hand-edit; run --build.
//
// --check is offline and instant, so it can gate every commit; --refresh is the
// only step that touches the network.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SNAPSHOT = join(HERE, "contest-sources.json");
const MAP = join(HERE, "contest-map.json");
const OUTPUT = join(ROOT, "js", "connectors", "contests-generated.js");
const CACHE = join(HERE, ".cache");

const CABRILLO_INDEX = "https://www.contestcalendar.com/cabnames.php";
const CABRILLO_DETAIL = (ref) => `https://www.contestcalendar.com/contestdetails.php?ref=${ref}`;
const N1MM_LIST = "https://n1mmwp.hamdocs.com/manual-supported/contests-list/";

// ── html helpers ─────────────────────────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#8211": "–", "#8217": "'", "#039": "'" };
const unescapeHtml = (s) =>
  s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e[0] === "#" ? String.fromCharCode(Number(e.slice(1))) : m));
const stripTags = (s) => unescapeHtml(s.replace(/<[^>]+>/g, "")).replace(/ /g, " ");
const squash = (s) => s.replace(/\s+/g, " ").trim();

// ── fetching (cached, rate-limited, retried) ─────────────────────────────────
async function fetchCached(url, key) {
  const path = join(CACHE, `${key}.html`);
  if (existsSync(path)) return readFile(path, "utf8");
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      await mkdir(CACHE, { recursive: true });
      await writeFile(path, body);
      return body;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`fetch failed: ${url} — ${lastErr.message}`);
}

async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

// ── parsing ──────────────────────────────────────────────────────────────────
// WA7BNM's Cabrillo-names table: calendar ref, contest name, Cabrillo keyword.
function parseCabrilloIndex(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((c) => squash(stripTags(c)));
    // Keep rows whose Cabrillo-name cell is blank: the snapshot is the record
    // of what the source says, and "this contest publishes no keyword" is a
    // fact worth keeping. The build skips them; they can never be mapped.
    if (cells.length >= 3 && /^\d+$/.test(cells[0])) {
      rows.push({ ref: cells[0], name: cells[1], cab: cells[2] ?? "" });
    }
  }
  return rows;
}

// A contest's detail page states its exchange and its Cabrillo name outright.
function parseCabrilloDetail(html) {
  const field = (label) => {
    const re = new RegExp(`>\\s*${label}\\s*:?\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i");
    const m = html.match(re);
    if (!m) return "";
    return squash(stripTags(m[1].replace(/<br\s*\/?>/gi, "|"))).replace(/^\|+|\|+$/g, "").trim();
  };
  return {
    exchange: field("Exchange"),
    cabName: field("Cabrillo name"),
    status: field("Status"),
    mode: field("Mode"),
  };
}

// N1MM's supported-contests table: its own contest code plus a description.
function parseN1mmList(html) {
  const seen = new Set();
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const tds = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [];
    if (tds.length !== 3) continue;
    const cells = tds.map((c) => squash(stripTags(c.replace(/<[^>]+>/g, " "))));
    const [code, , desc] = cells;
    if (!code || code.startsWith("Name Setup") || seen.has(code)) continue;
    seen.add(code);
    rows.push({ code, desc });
  }
  return rows;
}

// ── the build: snapshot + map -> catalog ─────────────────────────────────────

// Exchange shapes the logger can name as a single form field. Anything else —
// most contests, which ask for something role-conditional — is carried through
// as the source's own wording.
const EXCHANGE_FIELDS = [
  "Serial number", "Serial number + name", "CQ zone", "ITU zone", "Grid square",
  "State/province/country", "Name + state/province/country", "Power", "Age", "Signal report",
];
const SIGNAL_REPORT = /^(RS\(T\)|RST|RSQ|RS)\s*\+\s*/i;
const FIELD_RULES = [
  [/^serial no\.?( \(no signal report\))?$/i, "Serial number", true],
  [/^cq zone( no\.?)?$/i, "CQ zone", false],
  [/^itu zone( no\.?)?$/i, "ITU zone", false],
  [/^\d-character (grid square|maidenhead locator)$/i, "Grid square", false],
  [/^\(state\/province\/country\)$/i, "State/province/country", false],
  [/^name \+ \(state\/province\/country\)$/i, "Name + state/province/country", false],
  [/^power$/i, "Power", false],
  [/^\d-digit age$/i, "Age", false],
  [/^signal report$/i, "Signal report", false],
  [/^serial no\. \+ name$/i, "Serial number + name", true],
];

export function reduceExchange(sourceText) {
  const text = squash(sourceText);
  if (!text.includes("|")) {
    const core = text.replace(SIGNAL_REPORT, "").trim();
    for (const [re, label, serial] of FIELD_RULES) {
      if (re.test(core)) return { exch: label, serial };
    }
  }
  return { exch: text.split("|").join(" / "), serial: false };
}

// Map a reduced exchange label to the restructure logger's EXCHANGE_FIELDS keys
// (js/connectors/logbook.js). A key the catalog can't reduce to a single field
// falls through to the freeform "text" field — the operator types the whole
// exchange, same as the "Other" contest.
const LABEL_TO_KEYS = {
  "Serial number": ["serial"],
  "Serial number + name": ["serial", "name"],
  "CQ zone": ["cqzone"],
  "ITU zone": ["ituzone"],
  "Grid square": ["grid"],
  "State/province/country": ["state"],
  "Name + state/province/country": ["name", "state"],
  "Power": ["power"],
  "Age": ["age"],
  "Signal report": [], // RS(T) only; the rst column is added below
};

// Turn a sourced exchange string into the restructure's { sent, rcvd, me }
// shape. Whether the QSO line carries an RS(T) column is read from the source
// text itself (the "RS(T) + …" prefix, or a bare "Signal report"), NOT guessed
// — that column layout is what a log checker rejects. `me` is left empty: which
// element is fixed per-station is a per-contest modelling decision the sources
// don't encode, so the long tail is logged as a plain typed exchange.
const RST_TOKEN = /(RS\(T\)|RST|RSQ)/i; // a signal report anywhere in the text
export function toExchangeShape(sourceText) {
  const text = squash(sourceText);
  const shape = (fields) => { const f = fields.length ? fields : ["text"]; return { sent: f, rcvd: f.slice(), me: [] }; };
  if (!text.includes("|")) {
    // A clean single exchange leads with "RS(T) + …" if it carries a report;
    // strip that prefix and see whether the remainder names one field.
    const hasRST = SIGNAL_REPORT.test(text);
    const core = text.replace(SIGNAL_REPORT, "").trim();
    const rule = FIELD_RULES.find(([re]) => re.test(core));
    if (rule && rule[1] === "Signal report") return shape(["rst"]);
    const keys = rule ? LABEL_TO_KEYS[rule[1]] : ["text"];
    return shape([...(hasRST ? ["rst"] : []), ...keys]);
  }
  // Role-conditional (a "|" splits sender roles) — keep it freeform, but still
  // give it an RST column when a report appears in ANY branch (the prefix regex
  // would miss it, since the string leads with the role label, e.g. "W/VE:").
  return shape([...(RST_TOKEN.test(text) ? ["rst"] : []), "text"]);
}

// One Cabrillo keyword can cover several listed contests (a CW and an SSB leg,
// say). Prefer the shared name over an arbitrary one of them.
export function displayName(names) {
  if (names.length === 1) return names[0];
  const heads = [...new Set(names.map((n) => n.split(",")[0].trim()))];
  if (heads.length === 1) return heads[0];
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s,-]+$/, "");
  if (prefix.length >= 8) return prefix;
  return names.reduce((best, n) => (n.length < best.length ? n : best), names[0]);
}

// The Cabrillo keywords already covered by the hand-modelled CONTESTS in
// js/connectors/logbook.js (expanding each row's `cab` — a fixed string, or a
// byMode map's values). Those rows carry richer exchange/entry modelling than
// the generator can source, so the generator must NOT emit a second, cruder row
// for the same keyword; it augments the modelled majors with the long tail.
export async function coveredKeywords() {
  if (!globalThis.localStorage) {
    const m = new Map();
    globalThis.localStorage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
  const { CORE_CONTESTS } = await import("../js/connectors/logbook.js");
  const kws = new Set();
  for (const c of CORE_CONTESTS) {
    // Exclude both the Cabrillo keyword(s) a hand row already covers AND its
    // internal id — the restructure uses ids like "ARRL-FD" (keyword
    // ARRL-FIELD-DAY) that collide with a literal WA7BNM keyword, and a
    // generated row must never reuse an existing contest id.
    kws.add(c.id);
    if (typeof c.cab === "string") kws.add(c.cab);
    else if (c.cab && c.cab.byMode) Object.values(c.cab.byMode).forEach((k) => kws.add(k));
  }
  return kws;
}

const LEGAL_CAB = /^[A-Z0-9-]{1,32}$/;

// Build the generated catalog in the restructure logger's row shape:
//   { id, name, cab, n1mm, sent, rcvd, me }
// `id` doubles as the Cabrillo CONTEST: value (one row per keyword — WA7BNM
// already splits mode legs into separate keywords). Rows already modelled by
// hand (see coveredKeywords) and keywords that aren't a legal CONTEST: token are
// skipped rather than shipped wrong.
export function buildCatalog(snapshot, map, covered = new Set()) {
  const grouped = new Map();
  for (const row of snapshot.wa7bnm) {
    if (!Object.hasOwn(map, row.cab)) continue;
    if (!grouped.has(row.cab)) grouped.set(row.cab, []);
    grouped.get(row.cab).push(row);
  }
  const entries = [];
  for (const [cab, rows] of grouped) {
    if (covered.has(cab)) continue;      // richly modelled already
    if (!LEGAL_CAB.test(cab)) continue;  // not a legal CONTEST: token
    // Longest wins: where a keyword covers several legs, the fullest exchange
    // is the one that mentions every role.
    const source = rows.reduce((best, r) => (r.exchange.length > best.exchange.length ? r : best), rows[0]);
    if (!source.exchange.trim()) continue; // nothing sourced -> omit, never guess
    const { sent, rcvd, me } = toExchangeShape(source.exchange);
    entries.push({ id: cab, name: displayName(rows.map((r) => r.name)), cab, n1mm: map[cab], sent, rcvd, me });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

const jsString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function renderModule(entries, snapshot) {
  const arr = (a) => `[${a.map(jsString).join(", ")}]`;
  const lines = entries.map((e) =>
    `  { id: ${jsString(e.id)}, name: ${jsString(e.name)}, n1mm: ${jsString(e.n1mm)}, ` +
    `cab: ${jsString(e.cab)}, sent: ${arr(e.sent)}, rcvd: ${arr(e.rcvd)}, me: [] },`);
  return `// The long tail of N1MM Logger+'s supported-contest set, in the contest
// logbook's own row shape ({ id, name, cab, sent, rcvd, me }). This AUGMENTS the
// hand-modelled majors in js/connectors/logbook.js — it deliberately omits any
// Cabrillo keyword those already cover, so their richer exchange/entry modelling
// wins. \`id\` doubles as the Cabrillo CONTEST: value; \`sent\`/\`rcvd\` reference
// EXCHANGE_FIELDS keys defined in logbook.js.
//
// GENERATED — do not edit by hand. Regenerate with:
//   node tools/sync-contests.mjs --build
//
// Sourced from, and kept verbatim against:
//   ${snapshot.sources.cabrillo}   (Cabrillo names + exchanges)
//   ${snapshot.sources.n1mm}  (N1MM's set)
//
// A contest is listed only when both a Cabrillo keyword and an exchange could be
// sourced and the contest could be tied to an entry in N1MM's supported list —
// the rest are left out rather than guessed at.
export const GENERATED_CONTESTS = [
${lines.join("\n")}
];
`;
}

// ── drift: what changed upstream since the snapshot was taken ────────────────
// Rows are keyed on keyword *and* name: one Cabrillo keyword can cover several
// listed contests, so neither field alone identifies a row. Both are
// whitespace-squashed at parse time, so a newline cannot occur inside either
// and makes a collision-proof separator.
const rowKey = (r) => `${r.cab}\n${r.name}`;

export function diffSources(before, after, map) {
  const oldRows = new Map(before.wa7bnm.map((r) => [rowKey(r), r]));
  const newRows = new Map(after.wa7bnm.map((r) => [rowKey(r), r]));
  const oldCodes = new Set(before.n1mm.map((r) => r.code));
  const newCodes = new Set(after.n1mm.map((r) => r.code));
  const mappedCabs = new Set(Object.keys(map));
  const liveCabs = new Set(after.wa7bnm.map((r) => r.cab));

  return {
    exchangeChanged: [...newRows].filter(([k, r]) =>
      oldRows.has(k) && oldRows.get(k).exchange !== r.exchange && mappedCabs.has(r.cab))
      .map(([, r]) => ({ cab: r.cab, from: oldRows.get(rowKey(r)).exchange, to: r.exchange })),
    addedContests: [...newRows.values()].filter((r) => !oldRows.has(rowKey(r))),
    removedContests: [...oldRows.values()].filter((r) => !newRows.has(rowKey(r))),
    // A keyword we ship whose contest is gone from WA7BNM, or whose N1MM
    // contest no longer exists — both mean the pairing needs another look.
    danglingCab: [...mappedCabs].filter((cab) => !liveCabs.has(cab)),
    danglingN1mm: [...mappedCabs].filter((cab) => !newCodes.has(map[cab])),
    // Newly published keywords nobody has paired yet. Reported, never guessed.
    unmapped: [...liveCabs].filter((cab) => cab && !mappedCabs.has(cab)).sort(),
    // Contests WA7BNM lists without publishing a Cabrillo keyword at all.
    keywordless: after.wa7bnm.filter((r) => !r.cab).map((r) => r.name),
    n1mmAdded: [...newCodes].filter((c) => !oldCodes.has(c)),
    n1mmRemoved: [...oldCodes].filter((c) => !newCodes.has(c)),
  };
}

// ── commands ─────────────────────────────────────────────────────────────────
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

async function refresh() {
  const before = existsSync(SNAPSHOT) ? await readJson(SNAPSHOT) : { wa7bnm: [], n1mm: [] };
  const map = await readJson(MAP);

  process.stderr.write("fetching Cabrillo names index…\n");
  const index = parseCabrilloIndex(await fetchCached(CABRILLO_INDEX, "cabnames"));
  if (index.length < 100) throw new Error(`Cabrillo index parsed to only ${index.length} rows — page layout changed?`);

  process.stderr.write(`fetching ${index.length} contest detail pages…\n`);
  const details = await pooled(index, 4, async (row) => {
    const html = await fetchCached(CABRILLO_DETAIL(row.ref), `detail-${row.ref}`);
    return { ...row, ...parseCabrilloDetail(html) };
  });
  // The detail page restates the keyword; if it disagrees with the index the
  // parse is wrong and we must not build from it.
  for (const d of details) {
    if (d.cabName && d.cabName !== d.cab) {
      throw new Error(`keyword mismatch for ref ${d.ref}: index says ${d.cab}, detail page says ${d.cabName}`);
    }
  }

  process.stderr.write("fetching N1MM supported-contests list…\n");
  const n1mm = parseN1mmList(await fetchCached(N1MM_LIST, "n1mm-list"));
  if (n1mm.length < 100) throw new Error(`N1MM list parsed to only ${n1mm.length} rows — page layout changed?`);

  const after = {
    fetchedAt: new Date().toISOString(),
    sources: { cabrillo: CABRILLO_INDEX, n1mm: N1MM_LIST },
    wa7bnm: details.map(({ ref, cab, name, exchange, status, mode }) => ({ ref, cab, name, exchange, status, mode })),
    n1mm: n1mm.map(({ code, desc }) => ({ code, desc })),
  };
  // Only the timestamp moving is not news. Leave the file alone in that case
  // so a scheduled run produces no diff — and therefore no pull request —
  // unless the sources actually said something different.
  const facts = (s) => JSON.stringify({ ...s, fetchedAt: undefined });
  if (facts(before) === facts(after)) {
    console.log(`sources unchanged since ${before.fetchedAt} — snapshot left as is`);
    console.log(`snapshot: ${after.wa7bnm.length} Cabrillo keywords, ${after.n1mm.length} N1MM contests`);
    return diffSources(before, after, map);
  }
  await writeFile(SNAPSHOT, JSON.stringify(after, null, 1) + "\n");

  const drift = diffSources(before, after, map);
  report(drift, after);
  return drift;
}

function report(drift, snapshot) {
  const say = (label, rows, fmt) => {
    if (!rows.length) return;
    console.log(`\n${label} (${rows.length}):`);
    for (const r of rows.slice(0, 40)) console.log(`  ${fmt(r)}`);
    if (rows.length > 40) console.log(`  … and ${rows.length - 40} more`);
  };
  console.log(`snapshot: ${snapshot.wa7bnm.length} Cabrillo keywords, ${snapshot.n1mm.length} N1MM contests`);
  say("exchange text changed upstream", drift.exchangeChanged, (r) => `${r.cab}\n      was: ${r.from}\n      now: ${r.to}`);
  say("contests we ship that vanished from WA7BNM", drift.danglingCab, (r) => r);
  say("mapped N1MM contests that no longer exist", drift.danglingN1mm, (r) => r);
  say("new contests on WA7BNM", drift.addedContests, (r) => `${r.cab} — ${r.name}`);
  say("contests removed from WA7BNM", drift.removedContests, (r) => `${r.cab} — ${r.name}`);
  say("new N1MM contests", drift.n1mmAdded, (r) => r);
  say("N1MM contests removed", drift.n1mmRemoved, (r) => r);
  console.log(`\nunpaired Cabrillo keywords (need a human call before they can ship): ${drift.unmapped.length}`);
  if (drift.keywordless.length) {
    console.log(`contests WA7BNM lists with no Cabrillo keyword at all: ${drift.keywordless.length}`);
  }
  const actionable = drift.exchangeChanged.length + drift.danglingCab.length + drift.danglingN1mm.length;
  console.log(actionable
    ? `\n${actionable} shipped entr${actionable === 1 ? "y" : "ies"} affected — run --build and review the diff.`
    : "\nNothing we ship changed upstream.");
}

const OUTPUT_NAME = "js/connectors/contests-generated.js";

async function build({ write }) {
  const snapshot = await readJson(SNAPSHOT);
  const map = await readJson(MAP);
  const covered = await coveredKeywords();
  const entries = buildCatalog(snapshot, map, covered);
  const text = renderModule(entries, snapshot);
  if (write) {
    await writeFile(OUTPUT, text);
    console.log(`wrote ${OUTPUT_NAME} — ${entries.length} generated entries (${covered.size} keywords already modelled by hand, skipped)`);
    return 0;
  }
  const current = existsSync(OUTPUT) ? await readFile(OUTPUT, "utf8") : "";
  if (current === text) {
    console.log(`${OUTPUT_NAME} matches the sources (${entries.length} generated entries)`);
    return 0;
  }
  const a = current.split("\n"), b = text.split("\n");
  console.error(`${OUTPUT_NAME} is out of sync with tools/contest-sources.json + contest-map.json:`);
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 12; i++) {
    if (a[i] !== b[i]) { console.error(`  line ${i + 1}\n    committed: ${a[i] ?? "(none)"}\n    generated: ${b[i] ?? "(none)"}`); shown++; }
  }
  console.error("\nRun: node tools/sync-contests.mjs --build");
  return 1;
}

// Only act as a CLI when run directly — the pure builders above are imported
// by test-contest-sync.mjs.
const runAsCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const args = new Set(process.argv.slice(2));
if (runAsCli) try {
  if (args.has("--refresh")) {
    await refresh();
    process.exit(0);
  } else if (args.has("--build")) {
    process.exit(await build({ write: true }));
  } else if (args.has("--check")) {
    process.exit(await build({ write: false }));
  } else {
    console.error("usage: sync-contests.mjs --refresh | --build | --check");
    process.exit(2);
  }
} catch (err) {
  console.error(`sync-contests: ${err.message}`);
  process.exit(1);
}
