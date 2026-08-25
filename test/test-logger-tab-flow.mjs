// Pure unit tests for nextTabTarget in js/utils.js — the General entry pad's
// two-flow tab order. Run: node test-logger-tab-flow.mjs
//
// nextTabTarget sequences opaque items, so these tests use field-name strings
// where the app passes DOM elements. No DOM, no stubs.
import assert from "node:assert";
import { nextTabTarget } from "../js/utils.js";

// The General pad as drawn: main flow is the per-QSO loop, top flow is the
// set-once row (Frequency/Mode/Date/Time) that the CSS grid paints above it.
const MAIN = ["callsign", "sent", "rcvd", "location", "rig", "power", "notes"];
const TOP = ["frequency", "mode", "date", "time"];

const fwd = (target, main = MAIN, top = TOP) => nextTabTarget({ main, top, target });
const back = (target, main = MAIN, top = TOP) => nextTabTarget({ main, top, target, shift: true });

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ── main flow, forward ───────────────────────────────────────────────────────

check("main flow walks the per-QSO fields in order", () => {
  assert.deepStrictEqual(
    ["callsign", "sent", "rcvd", "location", "rig", "power"].map((f) => fwd(f)),
    ["sent", "rcvd", "location", "rig", "power", "notes"]
  );
});

// The loop is the point: an operator finishing a QSO tabs off the last field and
// is on Callsign ready for the next one, without reaching for the mouse.
check("main flow wraps from the last field back to the first", () => {
  assert.strictEqual(fwd("notes"), "callsign");
});

check("forward Tab never enters the top flow", () => {
  for (const field of MAIN) assert.ok(!TOP.includes(fwd(field)), `${field} leaked into the top flow`);
});

// ── top flow ─────────────────────────────────────────────────────────────────

check("top flow walks left-to-right as painted", () => {
  assert.deepStrictEqual(["frequency", "mode", "date"].map((f) => fwd(f)), ["mode", "date", "time"]);
});

// Clicking a top-row field is a detour, not a mode: tabbing off its end puts the
// operator back at the start of the repeating loop.
check("tabbing off the end of the top flow joins the main flow", () => {
  assert.strictEqual(fwd("time"), "callsign");
});

// ── reverse ──────────────────────────────────────────────────────────────────

check("Shift-Tab mirrors the main flow", () => {
  assert.deepStrictEqual(
    ["notes", "power", "rig", "location", "rcvd", "sent"].map((f) => back(f)),
    ["power", "rig", "location", "rcvd", "sent", "callsign"]
  );
});

// The one deliberate asymmetry — forward wraps Notes → Callsign, but backing out
// of Callsign opens the top row, so it is reachable without a mouse.
check("Shift-Tab out of the first main field enters the top flow at its end", () => {
  assert.strictEqual(back("callsign"), "time");
});

check("Shift-Tab mirrors the top flow", () => {
  assert.deepStrictEqual(["time", "date", "mode"].map((f) => back(f)), ["date", "mode", "frequency"]);
});

check("Shift-Tab off the start of the top flow closes the cycle at the last main field", () => {
  assert.strictEqual(back("frequency"), "notes");
});

// Every field must be reachable in reverse, or Shift-Tab strands the operator.
check("reverse visits every field and returns to its start", () => {
  const seen = [];
  let cur = "callsign";
  for (let i = 0; i < MAIN.length + TOP.length; i += 1) {
    seen.push(cur);
    cur = back(cur);
  }
  assert.strictEqual(cur, "callsign", "reverse cycle did not close");
  assert.deepStrictEqual([...seen].sort(), [...MAIN, ...TOP].sort(), "reverse cycle skipped a field");
});

// ── unmanaged targets ────────────────────────────────────────────────────────

// Returning null lets the browser do its thing. This is what keeps Save/Clear,
// the band/mode quick-set strips, and anything outside the pad on native order
// instead of being yanked into the flow.
check("an unmanaged field is left to the browser", () => {
  assert.strictEqual(fwd("save-button"), null);
  assert.strictEqual(back("save-button"), null);
});

// ── hidden and collapsed fields ──────────────────────────────────────────────

// The app filters display:none fields out before calling, so the flow has to
// stay correct on a short list rather than assume all seven are present.
check("flow closes over a gap when a field is hidden", () => {
  const noRig = ["callsign", "sent", "rcvd", "location", "power", "notes"];
  assert.strictEqual(fwd("location", noRig), "power");
  assert.strictEqual(back("power", noRig), "location");
});

// Mobile collapses Frequency/Mode behind the summary chip, leaving a shorter top
// row; with the whole row gone there is nothing to detour into.
check("a collapsed top row degrades to the main flow alone", () => {
  assert.strictEqual(back("callsign", MAIN, []), "notes", "should fall back to the main flow's end");
  assert.strictEqual(fwd("notes", MAIN, []), "callsign", "main flow should still wrap");
});

check("a shortened top row still joins the main flow at its end", () => {
  const shortTop = ["date", "time"];
  assert.strictEqual(fwd("date", MAIN, shortTop), "time");
  assert.strictEqual(fwd("time", MAIN, shortTop), "callsign");
  assert.strictEqual(back("callsign", MAIN, shortTop), "time");
});

// A single-field pad must not spin: next of the only field is itself, and the
// caller treats target === next as "let the browser handle it".
check("a single-field flow returns itself rather than looping forever", () => {
  assert.strictEqual(nextTabTarget({ main: ["callsign"], top: [], target: "callsign" }), "callsign");
});

check("empty flows never throw", () => {
  assert.strictEqual(nextTabTarget({ main: [], top: [], target: "callsign" }), null);
  assert.strictEqual(nextTabTarget({ target: "callsign" }), null);
});

process.stdout.write(`\nlogger-tab-flow: ${passed} assertions passed\n`);
