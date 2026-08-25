// Self-check for the contest-catalog generator (tools/sync-contests.mjs), which
// emits js/connectors/contests-generated.js from the WA7BNM + N1MM snapshot.
// The catalog is DERIVED, so if the reduction rules drift the module silently
// changes meaning — these pin the rules and the committed output. Run:
//   node test-contest-sync.mjs
import assert from "node:assert";
import { readFile } from "node:fs/promises";

// coveredKeywords() imports logbook.js, which touches localStorage at eval time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { reduceExchange, displayName, toExchangeShape, buildCatalog, renderModule, coveredKeywords } =
  await import("../tools/sync-contests.mjs");

const snapshot = JSON.parse(await readFile(new URL("../tools/contest-sources.json", import.meta.url), "utf8"));
const map = JSON.parse(await readFile(new URL("../tools/contest-map.json", import.meta.url), "utf8"));

let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { console.error("FAIL:", msg); process.exitCode = 1; } };
const eqJSON = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ── reduceExchange: the reduction rules (unchanged from the source generator) ─
eqJSON(reduceExchange("RS(T) + CQ zone"), { exch: "CQ zone", serial: false }, "RS(T) prefix stripped, CQ zone");
eqJSON(reduceExchange("RST + Serial No."), { exch: "Serial number", serial: true }, "serial reduces + flags serial");
eqJSON(reduceExchange("4-character grid square"), { exch: "Grid square", serial: false }, "grid");
ok(reduceExchange("YO: RS(T)+county|non-YO: RS(T)+Serial No.").serial === false, "role-conditional never auto-serials");

// ── toExchangeShape: source text -> restructure { sent, rcvd, me } ────────────
// RS(T) prefix -> an rst column; the reduced field maps to a logger field key.
eqJSON(toExchangeShape("RS(T) + CQ zone"), { sent: ["rst", "cqzone"], rcvd: ["rst", "cqzone"], me: [] }, "rst + cqzone");
eqJSON(toExchangeShape("RST + Serial No."), { sent: ["rst", "serial"], rcvd: ["rst", "serial"], me: [] }, "rst + serial");
eqJSON(toExchangeShape("4-character grid square"), { sent: ["grid"], rcvd: ["grid"], me: [] }, "grid, no rst");
eqJSON(toExchangeShape("Signal report"), { sent: ["rst"], rcvd: ["rst"], me: [] }, "bare signal report -> rst only");
// Role-conditional -> freeform text, honouring the leading RS(T).
eqJSON(toExchangeShape("W/VE: RS(T) + (state)|DX: RS(T) + serial"), { sent: ["rst", "text"], rcvd: ["rst", "text"], me: [] }, "role-conditional keeps rst + text");
eqJSON(toExchangeShape("10-10 number + name"), { sent: ["text"], rcvd: ["text"], me: [] }, "no rst, unmappable -> text only");

// ── determinism: the committed module is exactly what the generator emits ─────
const covered = await coveredKeywords();
const entries = buildCatalog(snapshot, map, covered);
const rebuilt = renderModule(entries, snapshot);
const committed = await readFile(new URL("../js/connectors/contests-generated.js", import.meta.url), "utf8");
ok(rebuilt === committed, "committed contests-generated.js matches a fresh --build (run: node tools/sync-contests.mjs --build)");
ok(entries.length > 150, `generated a substantial catalog (${entries.length} entries)`);

// ── shape invariants on every generated entry ────────────────────────────────
const LEGAL = /^[A-Z0-9-]{1,32}$/;
const FIELD_KEYS = new Set(["rst", "serial", "cqzone", "ituzone", "state", "section", "class", "prec", "check", "name", "age", "power", "grid", "text"]);
for (const e of entries) {
  ok(LEGAL.test(e.id), `${e.id}: id is a legal Cabrillo CONTEST: token`);
  ok(e.cab === e.id, `${e.id}: cab equals id`);
  eqJSON(e.me, [], `${e.id}: generated rows fix no per-station field`);
  ok([...e.sent, ...e.rcvd].every((k) => FIELD_KEYS.has(k)), `${e.id}: all field keys are real (${[...e.sent, ...e.rcvd]})`);
  ok(!covered.has(e.id), `${e.id}: not already modelled by hand (dedup)`);
}

console.log(`\ncontest-sync: ${passed} assertions passed, ${entries.length} generated entries verified`);
