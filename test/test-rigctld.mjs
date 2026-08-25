// Unit tests for the Hamlib rigctld line-protocol helpers in
// js/connectors/cat.js (rigctlSetFreqCommand / rigctlSetModeCommand /
// rigctlSetPttCommand / createRigctlParser). Run: node test-rigctld.mjs
//
// cat.js reads localStorage at import time via readStoredProfileId(); it
// already guards for `typeof localStorage === "undefined"`, so no stub needed.
// It does NOT touch the DOM or WebSocket at import, so it loads under plain
// node.
const {
  rigctlSetFreqCommand, rigctlSetModeCommand, rigctlSetPttCommand, createRigctlParser,
} = await import("../js/connectors/cat.js");

let passed = 0, failed = 0;
function assert(c, m) { if (c) passed++; else { failed++; console.error("FAIL:", m); } }
function eq(a, b, m) { assert(a === b, `${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function deep(a, b, m) { eq(JSON.stringify(a), JSON.stringify(b), m); }

// ── command builders — exact wire strings rigctld expects ───────────────────
eq(rigctlSetFreqCommand(14074000), "F 14074000", "set-freq command");
eq(rigctlSetFreqCommand(14074000.6), "F 14074001", "set-freq rounds to whole Hz");
eq(rigctlSetModeCommand("USB"), "M USB 0", "set-mode defaults passband to 0 (rig default)");
eq(rigctlSetModeCommand("CW", 500), "M CW 500", "set-mode carries an explicit passband");
eq(rigctlSetPttCommand(true), "T 1", "PTT on");
eq(rigctlSetPttCommand(false), "T 0", "PTT off");

// ── parser: a get-frequency reply is one line ───────────────────────────────
{
  const p = createRigctlParser();
  p.expect("freq");
  deep(p.feed("14074000\n"), [{ type: "frequency", hz: 14074000 }], "f -> one frequency event");
  eq(p.pendingCount(), 0, "freq descriptor consumed");
}

// ── parser: get-mode is TWO lines (mode, passband) ──────────────────────────
// The passband line is a small integer that a naive digit==frequency rule would
// misread as 2400 Hz. The queue attributes it correctly because it knows `m`
// consumes two lines.
{
  const p = createRigctlParser();
  p.expect("mode");
  const evs = p.feed("USB\n2400\n");
  deep(evs, [{ type: "mode", token: "USB", passbandHz: 2400 }], "m -> one mode event, passband not a frequency");
}

// ── parser: set commands reply RPRT <code> ──────────────────────────────────
{
  const p = createRigctlParser();
  p.expect("rprt");
  deep(p.feed("RPRT 0\n"), [{ type: "rprt", code: 0 }], "RPRT 0 success");
  p.expect("rprt");
  deep(p.feed("RPRT -1\n"), [{ type: "rprt", code: -1 }], "RPRT -1 error code preserved");
}

// ── parser: interleaved poll (f then m), replies arriving together ──────────
// This is the real polling case and the one most likely to misparse: after
// sending `f` and `m`, rigctld streams "14074000\nUSB\n2400\n". The freq must
// be the frequency and 2400 must be the mode's passband, NOT a second freq.
{
  const p = createRigctlParser();
  p.expect("freq");
  p.expect("mode");
  const evs = p.feed("14074000\nUSB\n2400\n");
  deep(evs, [
    { type: "frequency", hz: 14074000 },
    { type: "mode", token: "USB", passbandHz: 2400 },
  ], "interleaved f+m parse in order without cross-contamination");
  eq(p.pendingCount(), 0, "both descriptors consumed");
}

// ── parser: a reply split across two WebSocket messages ─────────────────────
// A bridge relaying a TCP stream can chop a line anywhere; a partial line must
// buffer, not emit garbage.
{
  const p = createRigctlParser();
  p.expect("freq");
  deep(p.feed("1407"), [], "partial line emits nothing yet");
  deep(p.feed("4000\n"), [{ type: "frequency", hz: 14074000 }], "completed line emits once");
}

// ── parser: \r\n line endings tolerated ─────────────────────────────────────
{
  const p = createRigctlParser();
  p.expect("freq");
  deep(p.feed("7040000\r\n"), [{ type: "frequency", hz: 7040000 }], "CRLF trimmed");
}

// ── parser: a bad freq line (0 / non-numeric) yields no event, not a lie ────
{
  const p = createRigctlParser();
  p.expect("freq");
  deep(p.feed("RPRT -1\n"), [], "an error where a frequency was expected emits no frequency");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
