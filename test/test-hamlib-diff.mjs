// The diff between WebHam's CAT data and Hamlib's, and the ledger that adjudicates
// it. Run: node test-hamlib-diff.mjs
//
// Two things are being tested, and the second one is the point:
//
//   1. That the comparison works — that it would actually notice a wrong byte. A
//      diff engine reporting "389 fields agree" is worthless if it would say the
//      same thing about a table full of garbage, so every category of finding is
//      mutation-tested: break the value, assert the verdict flips.
//
//   2. That the ledger is reconciled — no finding without a decision, no decision
//      without a finding, no decision coasting on a verdict that has since changed.
//
// The regression pins at the bottom name the specific bugs the diff found, so a
// failure says "newcat PTT is back to TX;" rather than "a byte changed".
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import {
  diffCatData, collectWebHam, reconcile, renderCommand, DECISIONS,
  MODE_ALIAS, YAESU5_ALIAS, modeAuthorities, yaesu5ModeTable, newcatModeTable,
  UNVERIFIED_FAMILIES, COMMAND_AUTHORITY,
} from "../tools/hamlib-diff.mjs";
import {
  extractStringLiterals, parseIcomPrivCaps, parseAsciiOps, buildCatalogue,
} from "../tools/sync-hamlib.mjs";
import {
  RADIO_FAMILIES, RADIO_PROFILES, CAT_COMMANDS,
  decodeCivMode, ft897ModeName, decodeKenwoodMode, decodeNewcatMode, decodeSmartSdrMode,
} from "../js/connectors/cat.js";
import { GENERATED_RIG_SPECS } from "../js/connectors/rigs-generated.js";

const snapshot = JSON.parse(await readFile(new URL("../tools/hamlib-sources.json", import.meta.url), "utf8"));
const ledger = JSON.parse(await readFile(new URL("../tools/hamlib-decisions.json", import.meta.url), "utf8"));
const mapJson = await readFile(new URL("../tools/hamlib-map.json", import.meta.url), "utf8");

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

const DECODERS = {
  "icom-civ": decodeCivMode,
  "yaesu-5byte": ft897ModeName,
  "kenwood-ascii": decodeKenwoodMode,
  "yaesu-ascii": decodeNewcatMode,
  "flex-ascii": decodeSmartSdrMode,
};

// The real thing, as it ships.
function realWebHam(overrides = {}) {
  return collectWebHam({
    families: RADIO_FAMILIES,
    commands: CAT_COMMANDS,
    decoders: DECODERS,
    profiles: RADIO_PROFILES,
    generatedSpecs: GENERATED_RIG_SPECS,
    ...overrides,
  });
}

const baseline = diffCatData({ snapshot, webham: realWebHam() });
const find = (result, key) => result.findings.find((f) => f.key === key);
const verdictOf = (result, key) => find(result, key)?.verdict;

// ── the diff runs, and says something ────────────────────────────────────────

check("the diff compares a substantial number of fields", () => {
  // Not a magic number to maintain — a floor. If this collapses, the collector has
  // stopped seeing part of WebHam and the "everything agrees" result is a lie.
  assert.ok(baseline.findings.length > 300, `only ${baseline.findings.length} fields compared`);
  assert.ok((baseline.counts.agrees ?? 0) > 300, `only ${baseline.counts.agrees} agree`);
});

check("every finding is well-formed", () => {
  const verdicts = new Set(["agrees", "diverges", "webham-only", "hamlib-only", "unverifiable"]);
  const seen = new Set();
  for (const f of baseline.findings) {
    assert.ok(f.key, `finding with no key: ${JSON.stringify(f)}`);
    assert.ok(!seen.has(f.key), `duplicate finding key ${f.key}`);
    seen.add(f.key);
    assert.ok(verdicts.has(f.verdict), `${f.key}: unknown verdict "${f.verdict}"`);
    assert.ok(f.area && f.subject !== undefined && f.field !== undefined, `${f.key}: incomplete`);
    // A non-agreeing finding with no explanation is unactionable.
    if (f.verdict === "unverifiable") assert.ok(f.note, `${f.key}: unverifiable with no reason given`);
  }
});

// ── mutation: would it notice? ───────────────────────────────────────────────

check("MUTATION a wrong mode byte is reported, with what it actually selects", () => {
  const families = clone(RADIO_FAMILIES);
  const usb = families["icom-civ-modern"].modes.find((m) => m.label === "USB");
  usb.value = "02"; // the old off-by-one: 0x02 is AM
  const result = diffCatData({ snapshot, webham: realWebHam({ families }) });
  const f = find(result, "mode-encode/icom-civ-modern/USB");
  assert.strictEqual(f.verdict, "diverges");
  assert.match(f.note, /AM/, "the report must name the mode the wrong byte actually selects");
  // And the clean run must not report it, or the assertion above proves nothing.
  assert.strictEqual(verdictOf(baseline, "mode-encode/icom-civ-modern/USB"), "agrees");
});

check("MUTATION a wrong CI-V opcode is reported", () => {
  const commands = clone(CAT_COMMANDS);
  commands["icom-civ"].setMode.cmd = 0x07; // C_SET_VFO
  const result = diffCatData({ snapshot, webham: realWebHam({ commands }) });
  assert.strictEqual(verdictOf(result, "command/icom-civ/setMode"), "diverges");
  assert.strictEqual(verdictOf(baseline, "command/icom-civ/setMode"), "agrees");
});

check("MUTATION a wrong Yaesu 5-byte opcode is reported", () => {
  const commands = clone(CAT_COMMANDS);
  commands["yaesu-5byte"].pttOn.opcode = 0x00; // "lock on"
  const result = diffCatData({ snapshot, webham: realWebHam({ commands }) });
  assert.strictEqual(verdictOf(result, "command/yaesu-5byte/pttOn"), "diverges");
});

check("MUTATION reverting newcat PTT to the Kenwood form is reported", () => {
  const commands = clone(CAT_COMMANDS);
  commands["yaesu-ascii"].pttOn = "TX;";
  commands["yaesu-ascii"].pttOff = "RX;";
  const result = diffCatData({ snapshot, webham: realWebHam({ commands }) });
  assert.strictEqual(verdictOf(result, "command/yaesu-ascii/pttOn"), "diverges");
  assert.strictEqual(verdictOf(result, "command/yaesu-ascii/pttOff"), "diverges");
});

check("MUTATION a wrong frequency digit count is reported", () => {
  const commands = clone(CAT_COMMANDS);
  commands["kenwood-ascii"].setFreq = { prefix: "FA", digits: 8 }; // Kenwood wants 11
  const result = diffCatData({ snapshot, webham: realWebHam({ commands }) });
  assert.strictEqual(verdictOf(result, "command/kenwood-ascii/setFreq"), "diverges");
});

check("MUTATION a wrong decode-table entry is reported", () => {
  const decoders = { ...DECODERS, "kenwood-ascii": (c) => (c === "4" ? "AM" : decodeKenwoodMode(c)) };
  const result = diffCatData({ snapshot, webham: realWebHam({ decoders }) });
  const f = find(result, "mode-decode/kenwood-ascii/'4'");
  assert.strictEqual(f.verdict, "diverges");
  assert.match(f.note, /FM/, "must say what upstream calls the code");
});

check("MUTATION a per-rig CI-V address that stops being emitted is reported", () => {
  const specs = clone(GENERATED_RIG_SPECS);
  delete specs["3073"].civAddr; // IC-7300
  const result = diffCatData({ snapshot, webham: realWebHam({ generatedSpecs: specs }) });
  assert.strictEqual(verdictOf(result, "civ-addr/3073"), "hamlib-only");
  assert.strictEqual(verdictOf(baseline, "civ-addr/3073"), "agrees");
});

check("MUTATION a wrong per-rig CI-V address is reported", () => {
  const specs = clone(GENERATED_RIG_SPECS);
  specs["3073"].civAddr = 0xa4; // the IC-705's address, on an IC-7300
  const result = diffCatData({ snapshot, webham: realWebHam({ generatedSpecs: specs }) });
  assert.strictEqual(verdictOf(result, "civ-addr/3073"), "diverges");
});

check("MUTATION dropping the 731-mode flag is reported", () => {
  const specs = clone(GENERATED_RIG_SPECS);
  delete specs["3064"].civ731;
  const result = diffCatData({ snapshot, webham: realWebHam({ generatedSpecs: specs }) });
  assert.strictEqual(verdictOf(result, "civ-731/3064"), "hamlib-only");
  assert.strictEqual(verdictOf(baseline, "civ-731/3064"), "agrees");
});

check("MUTATION restoring the controller address as the radio default is reported", () => {
  const commands = clone(CAT_COMMANDS);
  commands["icom-civ"].frame.defaultRadio = 0xe0; // CTRLID
  const result = diffCatData({ snapshot, webham: realWebHam({ commands }) });
  const f = find(result, "civ-frame/defaultRadio");
  assert.strictEqual(f.verdict, "diverges");
  assert.match(f.note, /controller/i);
});

check("MUTATION a wrong serial parameter is reported", () => {
  const specs = clone(GENERATED_RIG_SPECS);
  specs["3073"].serial = { baudRate: 115200, dataBits: 7, stopBits: 1, parity: "none", flowControl: "none" };
  const result = diffCatData({ snapshot, webham: realWebHam({ generatedSpecs: specs }) });
  assert.strictEqual(verdictOf(result, "serial/3073/dataBits"), "diverges");
});

// ── mutation: does silence require a reason? ─────────────────────────────────

check("MUTATION a new family with no authority and no excuse is reported, not skipped", () => {
  const families = clone(RADIO_FAMILIES);
  families["brand-new-protocol"] = {
    protocol: "brand-new", serial: {}, modes: [{ value: "01", label: "USB" }],
  };
  const result = diffCatData({ snapshot, webham: realWebHam({ families }) });
  const f = find(result, "mode-encode/brand-new-protocol");
  assert.strictEqual(f.verdict, "diverges", "an uncompared family must not pass silently");
  assert.match(f.note, /UNVERIFIED_FAMILIES/);
});

check("MUTATION a new protocol with no command authority is reported", () => {
  const commands = clone(CAT_COMMANDS);
  commands["brand-new"] = { setFreq: "XX;" };
  const result = diffCatData({ snapshot, webham: realWebHam({ commands }) });
  const f = find(result, "command/brand-new");
  assert.strictEqual(f.verdict, "diverges");
  assert.match(f.note, /UNVERIFIED_COMMAND_PROTOCOLS/);
});

check("MUTATION a lost citation makes the template unverifiable rather than passing", () => {
  // The guard that stops a hand-derived template from silently rotting when
  // upstream rewrites the literal it was read from.
  const mutated = clone(snapshot);
  mutated.vocabulary["yaesu-ascii"].ops.setPtt.literals =
    mutated.vocabulary["yaesu-ascii"].ops.setPtt.literals.filter((s) => s !== "TX1;");
  const result = diffCatData({ snapshot: mutated, webham: realWebHam() });
  const f = find(result, "command/yaesu-ascii/pttOn");
  assert.strictEqual(f.verdict, "unverifiable", "a template with no citation must not report agreement");
  assert.match(f.note, /citation lost/);
  // Without the guard this would have stayed "agrees" — which is the failure mode.
  assert.strictEqual(verdictOf(baseline, "command/yaesu-ascii/pttOn"), "agrees");
});

check("every citation in COMMAND_AUTHORITY is present in the snapshot", () => {
  for (const [protocol, spec] of Object.entries(COMMAND_AUTHORITY)) {
    for (const [op, rule] of Object.entries(spec.ops)) {
      const literals = snapshot.vocabulary[spec.vocab]?.ops?.[rule.from ?? op]?.literals ?? [];
      assert.ok(
        literals.includes(rule.cite),
        `${protocol}/${op}: template was derived from "${rule.cite}", which is no longer in the snapshot`
      );
    }
  }
});

// ── the alias-per-authority bug ──────────────────────────────────────────────

check("the Yaesu 5-byte table is read with its own vendor mode names", () => {
  // ncmd[]'s labels are Yaesu's spellings (DIG, PKT), not Hamlib's RIG_MODE_*
  // names. Applying the RIG_MODE_* alias map to it reported the FT-897's DIG mode
  // as diverging from itself: "WebHam DIG | Hamlib DIG".
  assert.strictEqual(verdictOf(baseline, "mode-encode/yaesu-5byte/DIG"), "agrees");
  assert.strictEqual(verdictOf(baseline, "mode-decode/yaesu-5byte/0x0a"), "agrees");
  assert.strictEqual(verdictOf(baseline, "mode-decode/yaesu-5byte/0x88"), "agrees");
  assert.strictEqual(MODE_ALIAS.DIG, undefined, "DIG must not be globally aliased");
  const authorities = modeAuthorities(snapshot.vocabulary);
  assert.strictEqual(authorities["yaesu-5byte"].alias("DIG"), "DIG");
  assert.strictEqual(authorities["kenwood-ascii"].alias("DATA-U"), "PKTUSB");
  assert.strictEqual(YAESU5_ALIAS["FM-N"], "FMN");
});

check("the two ASCII mode tables are kept apart", () => {
  // newcat and Kenwood both spell the command "MD" and agree only up to digit 7.
  const kenwood = snapshot.vocabulary["kenwood-ascii"].modeDigits;
  const newcat = newcatModeTable(snapshot.vocabulary);
  assert.strictEqual(newcat.PKTLSB, 8);
  assert.strictEqual(kenwood.PKTLSB, 12, "Kenwood puts PKTLSB on 12, not 8");
  assert.notStrictEqual(newcat.PKTUSB, kenwood.PKTUSB);
});

// ── the ledger ───────────────────────────────────────────────────────────────

const reconciliation = reconcile({ findings: baseline.findings, ledger });

check("every disagreement is adjudicated", () => {
  assert.deepStrictEqual(
    reconciliation.open.map((f) => f.key), [],
    "findings with no decision — either fix the value in cat.js or record why it stays"
  );
});

check("no ledger entry is stale", () => {
  assert.deepStrictEqual(
    reconciliation.stale, [],
    "entries excusing something that no longer disagrees — delete them, an unpruned ledger lies"
  );
});

check("no decision is coasting on a verdict that has changed", () => {
  assert.deepStrictEqual(reconciliation.drifted, []);
});

check("no ledger entry is malformed", () => {
  assert.deepStrictEqual(reconciliation.invalid, []);
});

check("every ledger entry carries a decision this tool understands and a reason", () => {
  for (const [key, entry] of Object.entries(ledger.decisions)) {
    assert.ok(DECISIONS[entry.decision], `${key}: unknown decision "${entry.decision}"`);
    assert.ok(entry.why && entry.why.length > 40, `${key}: needs a real reason, not a label`);
    assert.ok(entry.verdict, `${key}: no verdict recorded — drift cannot be detected without one`);
    if (entry.decision === "parked") {
      assert.ok(entry.followup, `${key}: parked without a followup is just hiding it`);
    }
  }
});

check("MUTATION an unadjudicated disagreement is caught", () => {
  const thinner = { decisions: { ...ledger.decisions } };
  delete thinner.decisions["civ-frame/controller"];
  const r = reconcile({ findings: baseline.findings, ledger: thinner });
  assert.deepStrictEqual(r.open.map((f) => f.key), ["civ-frame/controller"]);
});

check("MUTATION a stale entry is caught", () => {
  const padded = { decisions: { ...ledger.decisions, "mode-encode/icom-civ-modern/USB": {
    verdict: "diverges", decision: "keep-webham", why: "x".repeat(50),
  } } };
  const r = reconcile({ findings: baseline.findings, ledger: padded });
  assert.deepStrictEqual(
    r.stale.map((s) => s.key), ["mode-encode/icom-civ-modern/USB"],
    "an entry for a field that now agrees is stale"
  );
});

check("MUTATION a changed verdict is caught rather than excused", () => {
  const drifting = clone(ledger);
  drifting.decisions["civ-frame/controller"].verdict = "webham-only";
  const r = reconcile({ findings: baseline.findings, ledger: drifting });
  assert.deepStrictEqual(r.drifted, [{ key: "civ-frame/controller", was: "webham-only", now: "diverges" }]);
});

check("MUTATION a parked entry with no followup is caught", () => {
  const lazy = clone(ledger);
  delete lazy.decisions["serial/*"].followup;
  const r = reconcile({ findings: baseline.findings, ledger: lazy });
  assert.ok(r.invalid.some((i) => /followup/.test(i.why)));
});

check("a glob covers findings under its prefix, and an exact key wins over it", () => {
  const findings = [
    { key: "serial/1027/stopBits", verdict: "diverges" },
    { key: "serial/2006/baudRate", verdict: "diverges" },
  ];
  const globbed = { decisions: { "serial/*": { verdict: "diverges", decision: "parked", why: "x".repeat(50), followup: "y" } } };
  const r = reconcile({ findings, ledger: globbed });
  assert.deepStrictEqual(r.open, [], "the glob should cover both");
  assert.deepStrictEqual(r.stale, []);

  const both = { decisions: {
    "serial/*": { verdict: "diverges", decision: "parked", why: "x".repeat(50), followup: "y" },
    "serial/1027/stopBits": { verdict: "diverges", decision: "keep-webham", why: "x".repeat(50) },
  } };
  const r2 = reconcile({ findings, ledger: both });
  assert.deepStrictEqual(r2.open, []);
  assert.deepStrictEqual(r2.stale, []);
  assert.strictEqual(r2.decidedBy.get("serial/1027/stopBits"), "keep-webham", "exact key must win");
  assert.strictEqual(r2.decidedBy.get("serial/2006/baudRate"), "parked");
});

check("a glob that covers nothing is stale", () => {
  const r = reconcile({
    findings: [{ key: "serial/1027/stopBits", verdict: "diverges" }],
    ledger: { decisions: {
      "serial/*": { verdict: "diverges", decision: "parked", why: "x".repeat(50), followup: "y" },
      "nothing-here/*": { verdict: "diverges", decision: "parked", why: "x".repeat(50), followup: "y" },
    } },
  });
  assert.deepStrictEqual(r.stale.map((s) => s.key), ["nothing-here/*"]);
});

// ── the upstream extractors the diff depends on ──────────────────────────────

check("string literals are joined across PRI length macros, as C does", () => {
  // `"F%c%0*" PRIll ";"` is ONE format string. Recording it as two would make the
  // citation for newcat's set_freq unmatchable.
  assert.deepStrictEqual(extractStringLiterals('SNPRINTF(s, n, "F%c%0*"PRIll";", c, w, f);'), ["F%c%0*lld;"]);
  // A plain identifier between literals is a variable, not concatenation.
  assert.deepStrictEqual(extractStringLiterals('f("AB", x, "CD")'), ["AB", "CD"]);
});

check("an apostrophe in a comment does not swallow the rest of the file", () => {
  // The bug that made the first version of parseAsciiOps return all of newcat.c for
  // set_ptt and nothing at all for set_freq: brace matching treated the ' in
  // "don't" as a character literal and every brace after it disappeared.
  const source = [
    "int demo_set_ptt(RIG *rig, ptt_t ptt)",
    "{",
    "    /* we don't touch the cache here */",
    '    if (ptt) { SNPRINTF(s, n, "TX1;"); }',
    '    else { SNPRINTF(s, n, "TX0;"); }',
    "}",
    "int demo_set_freq(RIG *rig)",
    "{",
    '    SNPRINTF(s, n, "FA%011lld;");',
    "}",
  ].join("\n");
  const ops = parseAsciiOps(source, { setPtt: "demo_set_ptt", setFreq: "demo_set_freq" });
  assert.deepStrictEqual(ops.setPtt.literals, ["TX1;", "TX0;"]);
  assert.deepStrictEqual(ops.setFreq.literals, ["FA%011lld;"], "set_freq must not come back empty");
});

check("capability-probe arguments are not mistaken for commands", () => {
  // `newcat_valid_command(rig, "TX")` asks whether a rig supports TX; it does not
  // send it. Leaving it in made every backend look like it sends the bare token,
  // which would have hidden the TX;/TX1; bug this whole exercise found.
  const source = [
    "int demo_set_ptt(RIG *rig)",
    "{",
    '    if (!newcat_valid_command(rig, "TX")) { return -1; }',
    '    SNPRINTF(s, n, "TX1;");',
    "}",
  ].join("\n");
  const ops = parseAsciiOps(source, { setPtt: "demo_set_ptt" });
  assert.deepStrictEqual(ops.setPtt.literals, ["TX1;"]);
});

check("a renamed upstream function is reported, not silently empty", () => {
  const ops = parseAsciiOps("int other(void)\n{\n}\n", { setPtt: "demo_set_ptt" });
  assert.strictEqual(ops.setPtt.missing, true);
});

check("icom_priv_caps yields the CI-V address and the 731 flag", () => {
  const source = [
    "static const struct icom_priv_caps IC7300_priv_caps =",
    "{",
    "    0x94,   /* default address */",
    "    0,      /* 731 mode */",
    "    1,      /* no XCHG */",
    "};",
    "static const struct icom_priv_caps IC735_priv_caps =",
    "{",
    "    0x04,   /* default address */",
    "    1,      /* 731 mode */",
    "};",
  ].join("\n");
  const caps = parseIcomPrivCaps(source);
  assert.deepStrictEqual(caps.IC7300_priv_caps, { civAddr: 0x94, mode731: false });
  assert.deepStrictEqual(caps.IC735_priv_caps, { civAddr: 0x04, mode731: true });
});

check("MUTATION a CI-V rig mapped to a non-CI-V family is a build error", () => {
  // The Ten-Tec Delta II was mapped to kenwood-ascii while Hamlib implements it in
  // rigs/icom/delta2.c, so WebHam would have put Kenwood ASCII on the wire at 19200
  // for a radio speaking CI-V binary at 1200. Invisible from the WebHam side alone —
  // nothing in cat.js knows which radios are CI-V — so the check lives in the build.
  const delta = snapshot.rigs.find((r) => r.modelToken === "RIG_MODEL_DELTAII");
  assert.ok(delta?.icom, "the Delta II must still carry icom_priv_caps upstream");
  const mini = { ...snapshot, rigs: [delta] };
  const broken = buildCatalogue(mini, {
    modelFamilies: { RIG_MODEL_DELTAII: "kenwood-ascii" },
    civFamilies: ["icom-civ-classic", "icom-civ-modern"],
  });
  assert.strictEqual(broken.mapErrors.length, 1);
  assert.match(broken.mapErrors[0], /CI-V/);
  // And the CI-V fields must not be emitted onto a profile that cannot use them.
  assert.strictEqual(broken.emitted[0].civAddr, null);
  assert.strictEqual(broken.emitted[0].civ731, null);

  const fixed = buildCatalogue(mini, {
    modelFamilies: { RIG_MODEL_DELTAII: "icom-civ-classic" },
    civFamilies: ["icom-civ-classic", "icom-civ-modern"],
  });
  assert.deepStrictEqual(fixed.mapErrors, []);
  assert.strictEqual(fixed.emitted[0].civAddr, 1);
  assert.strictEqual(fixed.emitted[0].civ731, true);
});

check("the shipped map has no protocol-family errors", () => {
  const map = JSON.parse(mapJson);
  assert.deepStrictEqual(buildCatalogue(snapshot, map).mapErrors, []);
  assert.ok(map.civFamilies?.length, "civFamilies must be declared or the check is a no-op");
});

check("renderCommand turns a spec into the string that goes on the wire", () => {
  assert.strictEqual(renderCommand("MD0;"), "MD0;");
  assert.strictEqual(renderCommand({ prefix: "FA", digits: 11 }), "FA00014074000;");
  assert.strictEqual(renderCommand({ prefix: "FA", digits: 8 }), "FA14074000;");
  assert.strictEqual(renderCommand({ prefix: "MD" }, "0C"), "MD0C;");
});

// ── regression pins for the bugs the diff found ─────────────────────────────

check("REGRESSION newcat PTT keys the radio instead of polling it", () => {
  assert.strictEqual(CAT_COMMANDS["yaesu-ascii"].pttOn, "TX1;");
  assert.strictEqual(CAT_COMMANDS["yaesu-ascii"].pttOff, "TX0;");
  // Kenwood genuinely uses the bare forms and must not follow along.
  assert.strictEqual(CAT_COMMANDS["kenwood-ascii"].pttOn, "TX;");
  assert.strictEqual(CAT_COMMANDS["kenwood-ascii"].pttOff, "RX;");
});

check("REGRESSION newcat read-mode carries the VFO digit", () => {
  assert.strictEqual(CAT_COMMANDS["yaesu-ascii"].readMode, "MD0;");
  assert.strictEqual(CAT_COMMANDS["kenwood-ascii"].readMode, "MD;");
});

check("REGRESSION the CI-V fallback is not a controller address", () => {
  assert.strictEqual(CAT_COMMANDS["icom-civ"].frame.defaultRadio, snapshot.vocabulary["icom-civ"].frame.BCASTID);
  assert.notStrictEqual(CAT_COMMANDS["icom-civ"].frame.defaultRadio, snapshot.vocabulary["icom-civ"].frame.CTRLID);
});

check("REGRESSION Icom profiles carry their own CI-V address", () => {
  const civFamilies = new Set(
    Object.entries(RADIO_FAMILIES).filter(([, f]) => f.protocol === "icom-civ").map(([n]) => n)
  );
  const icoms = Object.entries(GENERATED_RIG_SPECS).filter(([, s]) => civFamilies.has(s.family));
  const withAddr = icoms.filter(([, s]) => s.civAddr !== undefined);
  assert.ok(icoms.length > 20, `only ${icoms.length} Icom profiles found`);
  assert.ok(
    withAddr.length >= 20,
    `only ${withAddr.length} of ${icoms.length} Icoms carry a CI-V address — the import regressed`
  );
  assert.strictEqual(RADIO_PROFILES["3073"].civAddr, 0x94, "IC-7300");
  // And no non-Icom picked one up.
  for (const [id, spec] of Object.entries(GENERATED_RIG_SPECS)) {
    if (!civFamilies.has(spec.family)) {
      assert.strictEqual(spec.civAddr, undefined, `${id} is not an Icom but carries a civAddr`);
    }
  }
});

check("REGRESSION Kenwood mode digit 8 names no mode", () => {
  assert.strictEqual(decodeKenwoodMode("8"), "");
  assert.strictEqual(snapshot.vocabulary["kenwood-ascii"].modeDigits[8], undefined);
});

check("every family is either compared against Hamlib or excused with a reason", () => {
  const authorities = modeAuthorities(snapshot.vocabulary);
  for (const family of Object.keys(RADIO_FAMILIES)) {
    assert.ok(
      authorities[family] || UNVERIFIED_FAMILIES[family],
      `${family} is neither checked against Hamlib nor listed in UNVERIFIED_FAMILIES with a reason`
    );
  }
});

process.stdout.write(`\nhamlib-diff: ${passed} assertions passed\n`);
process.stdout.write(
  `\n${baseline.counts.agrees} of ${baseline.findings.length} CAT fields agree with Hamlib ${snapshot.hamlibTag}; ` +
  `${baseline.findings.length - baseline.counts.agrees} adjudicated in tools/hamlib-decisions.json\n`
);
