// Hamlib is the source of truth for the bytes WebHam sends.
//
// Every mode value in RADIO_FAMILIES is a raw protocol code — cat.js does
// Number.parseInt(value, 16) and puts the result on the wire. Those codes are
// fixed by each protocol and tabulated as *data* in Hamlib's C source, which
// tools/sync-hamlib.mjs --refresh extracts into hamlib-sources.json's
// `vocabulary`. This suite asserts WebHam agrees with it, code by code.
//
// It exists because two of these tables were wrong in shipped code and nothing
// noticed:
//   - icom-civ-modern had every mode one code high, so an IC-7300 asked for USB
//     was sent 0x02 and went to AM.
//   - both yaesu-ascii families sent FM as "06", which is RTTY.
//
// Neither throws, neither logs; they just quietly drive the radio wrong. A
// hand-maintained byte table needs a mechanical check or it rots.
//
// Run: node test-cat-vocabulary.mjs
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { RADIO_FAMILIES } from "../js/connectors/cat.js";
import {
  modeAuthorities, yaesu5ModeTable, newcatModeTable, UNVERIFIED_FAMILIES,
} from "../tools/hamlib-diff.mjs";

const snapshot = JSON.parse(await readFile(new URL("../tools/hamlib-sources.json", import.meta.url), "utf8"));
const vocab = snapshot.vocabulary;

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ── each protocol's authoritative table, out of the snapshot ─────────────────
//
// The tables, the alias map and the list of deliberately-unverified families all
// come from tools/hamlib-diff.mjs rather than being restated here. They used to be
// duplicated, which is the same rot this suite exists to catch: two copies of a
// mode-name alias map drift, and a divergence excused in one copy but not the other
// is worse than no check at all. The engine owns them; this suite pins the
// regressions that motivated it.
const icom = vocab["icom-civ"].modeCodes;
const yaesu5 = yaesu5ModeTable(vocab);
const kenwood = vocab["kenwood-ascii"].modeDigits;
const newcat = newcatModeTable(vocab);

const AUTHORITY = modeAuthorities(vocab);
const UNVERIFIED = UNVERIFIED_FAMILIES;

// ── the assertions ───────────────────────────────────────────────────────────

check("the snapshot carries a vocabulary for every protocol we verify", () => {
  for (const name of ["icom-civ", "yaesu-5byte", "kenwood-ascii", "yaesu-ascii"]) {
    assert.ok(vocab[name], `snapshot has no vocabulary for ${name} — re-run --refresh`);
    assert.ok(vocab[name].source, `${name} vocabulary records no source file`);
  }
});

check("every family is either verified against Hamlib or explicitly excused", () => {
  for (const family of Object.keys(RADIO_FAMILIES)) {
    assert.ok(
      AUTHORITY[family] || UNVERIFIED[family],
      `${family} is neither checked against Hamlib nor listed in UNVERIFIED with a reason`
    );
  }
});

check("every mode byte WebHam sends matches Hamlib", () => {
  const wrong = [];
  for (const [family, { table, source, alias }] of Object.entries(AUTHORITY)) {
    for (const { value, label } of RADIO_FAMILIES[family].modes) {
      // Per-authority, not one global map: ncmd[]'s labels are Yaesu's own
      // spellings (DIG, PKT) while the other three tables use Hamlib's
      // RIG_MODE_* names.
      const key = alias(label);
      const expected = table[key];
      assert.notStrictEqual(
        expected, undefined,
        `${family} offers "${label}" but ${source} has no mode named ${key}`
      );
      const actual = Number.parseInt(value, 16);
      if (actual !== expected) {
        const actuallyIs = Object.keys(table).find((k) => table[k] === actual) ?? "nothing";
        wrong.push(
          `${family} ${label}: sends 0x${actual.toString(16).padStart(2, "0")} ` +
          `(= ${actuallyIs}), ${source} says 0x${expected.toString(16).padStart(2, "0")}`
        );
      }
    }
  }
  assert.deepStrictEqual(wrong, [], `mode codes disagree with Hamlib:\n    ${wrong.join("\n    ")}`);
});

// The two regressions this suite was written for, pinned individually so the
// failure message names the radio rather than just a byte.
check("an IC-7300 asked for USB sends 0x01, not 0x02 (AM)", () => {
  const usb = RADIO_FAMILIES["icom-civ-modern"].modes.find((m) => m.label === "USB");
  assert.strictEqual(Number.parseInt(usb.value, 16), icom.USB);
  assert.strictEqual(icom.USB, 0x01);
});

check("an FT-991A asked for FM sends 0x04, not 0x06 (RTTY)", () => {
  const fm = RADIO_FAMILIES["yaesu-ascii-modern"].modes.find((m) => m.label === "FM");
  assert.strictEqual(Number.parseInt(fm.value, 16), newcat.FM);
  assert.strictEqual(newcat.FM, 0x04);
  assert.strictEqual(newcat.RTTY, 0x06, "0x06 is RTTY — that was the bug");
});

check("no family offers a duplicate mode code", () => {
  for (const [family, def] of Object.entries(RADIO_FAMILIES)) {
    const seen = new Map();
    for (const { value, label } of def.modes) {
      const prior = seen.get(value);
      assert.ok(!prior, `${family}: "${label}" and "${prior}" both send ${value}`);
      seen.set(value, label);
    }
  }
});

check("every mode value parses as a byte", () => {
  for (const [family, def] of Object.entries(RADIO_FAMILIES)) {
    for (const { value, label } of def.modes) {
      if (def.protocol === "rigctld") continue; // symbolic names, not bytes
      const n = Number.parseInt(value, 16);
      assert.ok(Number.isInteger(n) && n >= 0 && n <= 0xff, `${family} ${label}: "${value}" is not a byte`);
    }
  }
});

// ── coverage the import makes available ──────────────────────────────────────

// Not a failure — a report. Hamlib knows codes for modes WebHam does not offer,
// and the digital ones matter (PKTUSB is what FT8 wants).
const gaps = [];
for (const [family, { table, alias }] of Object.entries(AUTHORITY)) {
  const have = new Set(RADIO_FAMILIES[family].modes.map((m) => alias(m.label)));
  const missing = ["CWR", "RTTY", "RTTYR", "PKTUSB", "PKTLSB", "FMN", "AM", "DSTAR"]
    .filter((k) => table[k] !== undefined && !have.has(k));
  if (missing.length) gaps.push(`    ${family}: ${missing.join(" ")}`);
}

process.stdout.write(`\ncat-vocabulary: ${passed} assertions passed\n`);
if (gaps.length) {
  process.stdout.write(`\nAvailable from Hamlib but not offered (coverage, not a failure):\n${gaps.join("\n")}\n`);
}
for (const [family, why] of Object.entries(UNVERIFIED)) {
  process.stdout.write(`\nNOT verified — ${family}:\n    ${why}\n`);
}
