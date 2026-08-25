// What does WebHam's CAT data disagree with Hamlib about?
//
// WebHam's CAT tables were written by hand. Much of them is right — every command
// opcode, every Yaesu 5-byte frame, every Kenwood ASCII command matches upstream
// exactly. So the goal is NOT to replace WebHam's values with Hamlib's. It is to
// find out which values differ, and decide each one on its merits.
//
// This module is the comparison. It classifies every comparable field into one of
// five verdicts:
//
//   agrees        WebHam and Hamlib hold the same value. Keep WebHam's, do
//                 nothing, record nothing. This is the common case and the whole
//                 point — 200-odd fields agree, and they cost no attention.
//   diverges      Both have a value and they differ. Needs a decision.
//   webham-only   WebHam has a value where Hamlib's authority has none.
//   hamlib-only   Hamlib has a value WebHam does not offer. Coverage, not a bug.
//   unverifiable  No upstream authority exists for this field, with a reason.
//
// Only non-`agrees` findings need adjudicating, and tools/hamlib-decisions.json
// records the call on each. Nothing here changes any value; the engine reports
// and the ledger remembers.
//
// WHY THE COMPARISON IS SPLIT IN TWO. The snapshot (hamlib-sources.json) holds
// upstream verbatim, including raw C format strings like `MD%c%c`. Reading
// `MD%c%c` as "MD, a VFO digit, then the terminator" is a human judgement about
// C semantics, so it lives here, next to the `cite` of the exact literal it was
// derived from. If upstream rewrites that literal the citation check fails loudly
// and the reading has to be redone — which is the only thing standing between a
// hand-derived template and silent rot.

// ── mode-name vocabulary ─────────────────────────────────────────────────────

// WebHam's display labels vs Hamlib's symbolic mode names. Explicit, never
// fuzzy-matched: a wrong alias here would silently excuse a wrong byte.
//
// This is the map for the three tables that use Hamlib's own RIG_MODE_* names —
// icom_defs.h, kenwood.c and newcat.c.
export const MODE_ALIAS = {
  "CW-U": "CW", "CW-L": "CWR", "CW-R": "CWR",
  "DATA-U": "PKTUSB", "DATA-L": "PKTLSB",
  "RTTY-R": "RTTYR", "FM-N": "FMN", "DV": "DSTAR", "AM-N": "AMN", "PKT-FM": "PKTFM",
  // Elecraft's manual calls MD digit 6 "DATA"; Hamlib routes Elecraft rigs
  // through kenwood.c's generic table, which canonicalises the same digit as
  // RIG_MODE_RTTY (on a K3, DATA covers RTTY/PSK/FSK by DT sub-mode). Same byte,
  // different vendor name — a naming alias, not a divergence. Checked: Hamlib has
  // no Elecraft-specific mode table to disagree with.
  "DATA": "RTTY",
  // Decode-side spellings. WebHam's decoders were written independently of its
  // encode tables and use their own names for the same codes.
  "FSK-R": "RTTYR", "DIG/FSK": "RTTY",
};

// The Yaesu 5-byte table is NOT keyed by RIG_MODE_* names. Its keys come from
// ncmd[]'s own comments, which use Yaesu's vendor spellings — "DIG" and "PKT",
// not PKTUSB and PKTLSB. Applying the RIG_MODE_* map to it reported the FT-897's
// DIG mode as a divergence against itself: WebHam DIG, Hamlib DIG, "disagree".
// Aliases are a property of the authority, not a global.
// ncmd[]'s label for 0x88 is "mode set main FM-N", and yaesu5ModeTable strips the
// hyphen to key it as FMN. cat.js's decoder spells it "FM-N", so the one alias this
// authority needs is that spelling.
export const YAESU5_ALIAS = { "FM-N": "FMN" };

const aliasWith = (map) => (label) => map[label] ?? label;
const alias = aliasWith(MODE_ALIAS);

// Hamlib's tables are name -> code, and several names share a code (icom_defs.h
// gives AM and AMN both 0x02). Invert to code -> [names] so a WebHam label can be
// checked against every name upstream accepts for that code.
function invert(table) {
  const out = new Map();
  for (const [name, code] of Object.entries(table)) {
    if (!out.has(code)) out.set(code, []);
    out.get(code).push(name);
  }
  return out;
}

// ── Hamlib's mode tables, per protocol ───────────────────────────────────────

// The Yaesu 5-byte mode codes are not a table upstream; they are the first byte
// of the ncmd[] rows labelled "mode set main <MODE>". "FM-N" is hyphenated there.
export function yaesu5ModeTable(vocabulary) {
  return Object.fromEntries(
    vocabulary["yaesu-5byte"].ncmd
      .filter((r) => r.label.startsWith("mode set main "))
      .map((r) => [r.label.slice("mode set main ".length).replace("-", ""), r.bytes[0]])
  );
}

// Newcat stores the MD character; WebHam stores the same value as a hex string
// ('C' -> "0C"), so parse it as hex to compare numerically.
export function newcatModeTable(vocabulary) {
  return Object.fromEntries(
    Object.entries(vocabulary["yaesu-ascii"].modeChars).map(([k, c]) => [k, Number.parseInt(c, 16)])
  );
}

export function modeAuthorities(vocabulary) {
  const icom = vocabulary["icom-civ"].modeCodes;
  const kenwood = vocabulary["kenwood-ascii"].modeDigits;
  const yaesu5 = yaesu5ModeTable(vocabulary);
  const newcat = newcatModeTable(vocabulary);
  return {
    "yaesu-5byte": { table: yaesu5, source: "ft897.c ncmd[]", alias: aliasWith(YAESU5_ALIAS) },
    "yaesu-ascii-modern": { table: newcat, source: "newcat.c newcat_mode_conv[]", alias },
    "icom-civ-classic": { table: icom, source: "icom_defs.h S_*", alias },
    "icom-civ-modern": { table: icom, source: "icom_defs.h S_*", alias },
    "kenwood-ascii": { table: kenwood, source: "kenwood.c mode table", alias },
    "elecraft-ascii": { table: kenwood, source: "kenwood.c mode table", alias },
  };
}

// Families with no upstream authority, each with the reason. A silent omission
// here would be a place to hide failures, so the diff requires every family to be
// either compared or listed.
export const UNVERIFIED_FAMILIES = {
  "yaesu-ascii-classic":
    "its rigs (FT-747/757/767/840/890/900/920/980/990/1000) are not newcat in Hamlib — " +
    "each has its own backend speaking a binary protocol, with no ASCII MD command at all, " +
    "so newcat's table is not authoritative for them. Needs a protocol review, not a byte fix.",
  "flex-ascii":
    "WebHam drives SmartSDR CAT, the virtual COM port that emulates a Kenwood with " +
    "ZZ-prefixed commands. Hamlib's flexradio backend drives the SmartSDR TCP API instead " +
    "(`slice tune 0 14.074`, `xmit 1`), so upstream has no ZZ vocabulary to compare against.",
  "hamlib-rigctld":
    "rigctld takes symbolic mode names over the bridge, not raw protocol bytes, so Hamlib " +
    "normalises away the very codes this diff compares.",
};

// ── command templates ────────────────────────────────────────────────────────
//
// `cite` is the literal as extracted into the snapshot, and it is verified to
// still be there. `expect` is the hand-derived reading of that literal, against
// which WebHam's actual command is matched. `describe` is what goes in the report.
//
// Commands are compared with the trailing ";" stripped from both sides: kenwood.c
// omits the terminator (kenwood_transaction appends it) while newcat.c includes
// it, and that is a difference in upstream's plumbing, not in the command.
export const COMMAND_AUTHORITY = {
  "kenwood-ascii": {
    vocab: "kenwood-ascii",
    ops: {
      setFreq: { cite: "F%c%011lld", expect: /^F[AB]\d{11}$/, describe: "F<vfo> + 11 digits" },
      readFreq: { cite: "F%c", expect: /^F[AB]$/, describe: "F<vfo>" },
      setMode: { cite: "MD%c", expect: /^MD.$/, describe: "MD + one mode character" },
      readMode: { cite: "MD", expect: /^MD$/, describe: "MD" },
      pttOn: { from: "setPtt", cite: "TX", expect: /^TX$/, describe: "TX" },
      pttOff: { from: "setPtt", cite: "RX", expect: /^RX$/, describe: "RX" },
    },
  },
  "yaesu-ascii": {
    vocab: "yaesu-ascii",
    ops: {
      // newcat_set_freq formats "F%c%0*lld;" with priv->width_frequency, which is
      // 8 or 9 depending on the rig and is probed at runtime from the IF; reply
      // length. A static template cannot pin it, so both widths are accepted and
      // the per-rig width is reported separately as unverifiable.
      setFreq: { cite: "F%c%0*lld;", expect: /^F[AB]\d{8,9}$/, describe: "F<vfo> + 8 or 9 digits (width probed at runtime)" },
      readFreq: { cite: "F%c", expect: /^F[AB]$/, describe: "F<vfo>" },
      // "MD0x%c" with cat_term, then cmd_str[2] = VFO digit and cmd_str[3] = mode
      // char: the lowercase x is a placeholder that gets overwritten. So the wire
      // form is MD + VFO digit + mode char.
      setMode: { cite: "MD0x%c", expect: /^MD[01].$/, describe: "MD + VFO digit + mode character" },
      // "MD%c%c" = MD + main_sub_vfo + cat_term. The VFO digit is not optional.
      readMode: { cite: "MD%c%c", expect: /^MD[01]$/, describe: "MD + VFO digit" },
      pttOn: { from: "setPtt", cite: "TX1;", expect: /^TX1$/, describe: "TX1" },
      pttOff: { from: "setPtt", cite: "TX0;", expect: /^TX0$/, describe: "TX0" },
    },
  },
};

// Protocols with no comparable upstream command vocabulary.
export const UNVERIFIED_COMMAND_PROTOCOLS = {
  "flex-ascii": UNVERIFIED_FAMILIES["flex-ascii"],
};

// Protocols checked opcode-by-opcode above rather than through a template,
// because upstream states them as values and not as format strings: every Yaesu
// 5-byte frame is a literal ncmd[] row, and every CI-V opcode is a C_* #define.
// They are fully compared — listing them as "unverifiable" would have been a
// false negative in the diff's own bookkeeping.
export const DIRECT_COMMAND_PROTOCOLS = new Set(["icom-civ", "yaesu-5byte"]);

// A representative frequency and the mode values used to render WebHam's
// parameterised commands into something matchable. 14.074 MHz is 8 digits, which
// is what makes the newcat width question visible rather than hidden by padding.
const SAMPLE_FREQ_HZ = 14074000;

// ── the WebHam side ──────────────────────────────────────────────────────────

// Probe a decode function over its input domain instead of reading a table out of
// it. This compares the behaviour that ships, not a copy of it — and cat.js keeps
// these maps inside the functions, so there is no table to read.
function probeDecoder(fn, domain) {
  const out = new Map();
  for (const key of domain) {
    const label = fn(key);
    // Each decoder signals "I don't know this code" differently: cat.js's byte
    // decoders return a "Mode 0x.." / "Unknown (0x..)" placeholder, the ASCII ones
    // return "".
    if (!label || /^(?:Mode 0x|Unknown \()/.test(label)) continue;
    out.set(key, label);
  }
  return out;
}

const BYTE_DOMAIN = Array.from({ length: 256 }, (_, i) => i);
const DIGIT_DOMAIN = "0123456789ABCDEF".split("");

// Which decoder answers for which protocol, and over what domain. The `table`
// picks Hamlib's counterpart out of the vocabulary.
export const DECODE_SUBJECTS = {
  "icom-civ": { domain: BYTE_DOMAIN, table: (v) => v["icom-civ"].modeCodes, source: "icom_defs.h S_*", alias },
  "yaesu-5byte": { domain: BYTE_DOMAIN, table: yaesu5ModeTable, source: "ft897.c ncmd[]", alias: aliasWith(YAESU5_ALIAS) },
  "kenwood-ascii": { domain: DIGIT_DOMAIN, table: (v) => v["kenwood-ascii"].modeDigits, source: "kenwood.c mode table", alias },
  "yaesu-ascii": { domain: DIGIT_DOMAIN, table: newcatModeTable, source: "newcat.c newcat_mode_conv[]", alias },
  "flex-ascii": { domain: DIGIT_DOMAIN, table: null, source: null, alias },
};

// Assemble everything WebHam knows, from the modules that actually ship it.
// Passed in rather than imported so this module stays pure and testable, and so a
// test can feed it a deliberately-wrong table to prove a guard bites.
export function collectWebHam({ families, commands, decoders, profiles, generatedSpecs }) {
  return { families, commands, decoders, profiles, generatedSpecs };
}

// ── the diff ─────────────────────────────────────────────────────────────────

const fmtByte = (n) => `0x${n.toString(16).padStart(2, "0")}`;

function finding(f) {
  return { note: null, ...f };
}

export function diffCatData({ snapshot, webham }) {
  const v = snapshot.vocabulary;
  const findings = [];
  const push = (f) => findings.push(finding(f));

  // ── 1. mode encode tables: the bytes WebHam sends to set a mode ────────────
  const authorities = modeAuthorities(v);
  for (const family of Object.keys(webham.families)) {
    if (UNVERIFIED_FAMILIES[family]) {
      push({
        key: `mode-encode/${family}`,
        area: "mode-encode",
        subject: family,
        field: "(whole table)",
        verdict: "unverifiable",
        webham: `${webham.families[family].modes.length} modes`,
        hamlib: null,
        authority: null,
        note: UNVERIFIED_FAMILIES[family],
      });
      continue;
    }
    const authority = authorities[family];
    if (!authority) {
      // Neither compared nor excused. A new family must land here loudly rather
      // than pass unexamined.
      push({
        key: `mode-encode/${family}`,
        area: "mode-encode",
        subject: family,
        field: "(whole table)",
        verdict: "diverges",
        webham: `${webham.families[family].modes.length} modes`,
        hamlib: null,
        authority: null,
        note: "family has no Hamlib authority and no entry in UNVERIFIED_FAMILIES — add one or the other",
      });
      continue;
    }
    const byCode = invert(authority.table);
    for (const { value, label } of webham.families[family].modes) {
      const actual = Number.parseInt(value, 16);
      const upstreamNames = byCode.get(actual) ?? [];
      const wanted = authority.alias(label);
      const key = `mode-encode/${family}/${label}`;
      if (upstreamNames.includes(wanted)) {
        push({ key, area: "mode-encode", subject: family, field: label, verdict: "agrees",
               webham: fmtByte(actual), hamlib: fmtByte(actual), authority: authority.source });
        continue;
      }
      const expected = authority.table[wanted];
      if (expected === undefined) {
        push({ key, area: "mode-encode", subject: family, field: label, verdict: "webham-only",
               webham: fmtByte(actual), hamlib: null, authority: authority.source,
               note: `${authority.source} has no mode named ${wanted}` });
        continue;
      }
      push({ key, area: "mode-encode", subject: family, field: label, verdict: "diverges",
             webham: fmtByte(actual), hamlib: fmtByte(expected), authority: authority.source,
             note: `sends ${fmtByte(actual)}, which upstream calls ${upstreamNames.join("/") || "nothing"}` });
    }
    // Coverage: codes Hamlib knows that this family does not offer.
    const offered = new Set(webham.families[family].modes.map((m) => authority.alias(m.label)));
    for (const name of ["CWR", "RTTY", "RTTYR", "PKTUSB", "PKTLSB", "FMN", "AM", "DSTAR"]) {
      if (authority.table[name] === undefined || offered.has(name)) continue;
      push({ key: `mode-encode/${family}/+${name}`, area: "mode-encode", subject: family, field: `+${name}`,
             verdict: "hamlib-only", webham: null, hamlib: fmtByte(authority.table[name]),
             authority: authority.source, note: `Hamlib knows ${name}; this family does not offer it` });
    }
  }

  // ── 2. mode decode tables: how WebHam names a code the radio reports ───────
  for (const [protocol, subject] of Object.entries(DECODE_SUBJECTS)) {
    const fn = webham.decoders[protocol];
    if (!fn) continue;
    const probed = probeDecoder(fn, subject.domain);
    if (!subject.table) {
      push({ key: `mode-decode/${protocol}`, area: "mode-decode", subject: protocol, field: "(whole table)",
             verdict: "unverifiable", webham: `${probed.size} codes`, hamlib: null, authority: null,
             note: UNVERIFIED_FAMILIES[protocol] ?? "no upstream table" });
      continue;
    }
    const table = subject.table(v);
    const byCode = invert(table);
    for (const [key, label] of probed) {
      // The ASCII decoders are keyed by character, the binary ones by byte.
      const code = typeof key === "string" ? Number.parseInt(key, 16) : key;
      const shown = typeof key === "string" ? `'${key}'` : fmtByte(key);
      const fkey = `mode-decode/${protocol}/${shown}`;
      const upstreamNames = byCode.get(code) ?? [];
      const wanted = subject.alias(label);
      if (upstreamNames.includes(wanted)) {
        push({ key: fkey, area: "mode-decode", subject: protocol, field: shown, verdict: "agrees",
               webham: label, hamlib: wanted, authority: subject.source });
      } else if (upstreamNames.length === 0) {
        push({ key: fkey, area: "mode-decode", subject: protocol, field: shown, verdict: "webham-only",
               webham: label, hamlib: null, authority: subject.source,
               note: `${subject.source} assigns no mode to ${shown}` });
      } else {
        push({ key: fkey, area: "mode-decode", subject: protocol, field: shown, verdict: "diverges",
               webham: label, hamlib: upstreamNames.join("/"), authority: subject.source,
               note: `WebHam reports ${shown} as "${label}"; upstream calls it ${upstreamNames.join("/")}` });
      }
    }
  }

  // ── 3. command opcodes and command strings ─────────────────────────────────

  // Icom CI-V: WebHam's opcodes against icom_defs.h's C_* constants, and its frame
  // bytes against PR / FI / CTRLID.
  const civ = webham.commands["icom-civ"];
  const C = v["icom-civ"].commands;
  const S = v["icom-civ"].subCommands;
  const CIV_OPCODES = [
    ["readFreq", civ.readFreq.cmd, "RD_FREQ"],
    ["readMode", civ.readMode.cmd, "RD_MODE"],
    ["setFreq", civ.setFreq.cmd, "SET_FREQ"],
    ["setMode", civ.setMode.cmd, "SET_MODE"],
    ["ptt", civ.ptt.cmd, "CTL_PTT"],
  ];
  for (const [op, actual, name] of CIV_OPCODES) {
    const expected = C[name];
    push({
      key: `command/icom-civ/${op}`, area: "command", subject: "icom-civ", field: op,
      verdict: expected === actual ? "agrees" : "diverges",
      webham: fmtByte(actual), hamlib: expected === undefined ? null : fmtByte(expected),
      authority: `icom_defs.h C_${name}`,
      note: expected === actual ? null : `WebHam sends ${fmtByte(actual)}, C_${name} is ${fmtByte(expected)}`,
    });
  }
  push({
    key: "command/icom-civ/ptt.sub", area: "command", subject: "icom-civ", field: "ptt sub-command",
    verdict: S.PTT === civ.ptt.sub ? "agrees" : "diverges",
    webham: fmtByte(civ.ptt.sub), hamlib: S.PTT === undefined ? null : fmtByte(S.PTT),
    authority: "icom_defs.h S_PTT",
  });
  const FRAME = [
    ["preamble", civ.frame.preamble, "PR", "the two-byte frame preamble"],
    ["terminator", civ.frame.terminator, "FI", "the end-of-message byte"],
  ];
  for (const [field, actual, name, what] of FRAME) {
    push({
      key: `civ-frame/${field}`, area: "civ-frame", subject: "icom-civ", field,
      verdict: v["icom-civ"].frame[name] === actual ? "agrees" : "diverges",
      webham: fmtByte(actual), hamlib: fmtByte(v["icom-civ"].frame[name]),
      authority: `icom_defs.h ${name}`, note: what,
    });
  }
  // The two addresses. CTRLID is the controller's own address, so it is what
  // `controller` should be — and emphatically not a default to send TO.
  push({
    key: "civ-frame/controller", area: "civ-frame", subject: "icom-civ", field: "controller address",
    verdict: v["icom-civ"].frame.CTRLID === civ.frame.controller ? "agrees" : "diverges",
    webham: fmtByte(civ.frame.controller), hamlib: fmtByte(v["icom-civ"].frame.CTRLID),
    authority: "icom_defs.h CTRLID",
    note: "the `from` byte WebHam signs frames with",
  });
  // The fallback used when a rig carries no address of its own. There is no single
  // upstream value to compare against — Hamlib's answer is "per rig" — so what is
  // checkable is the narrower thing: whichever value WebHam falls back to must not
  // be a controller's address, because a radio will never answer one.
  push({
    key: "civ-frame/defaultRadio", area: "civ-frame", subject: "icom-civ", field: "default radio address",
    verdict: civ.frame.defaultRadio === v["icom-civ"].frame.CTRLID ? "diverges" : "agrees",
    webham: fmtByte(civ.frame.defaultRadio),
    hamlib: `not ${fmtByte(v["icom-civ"].frame.CTRLID)} (CTRLID); per-rig re_civ_addr, else ` +
            `${fmtByte(v["icom-civ"].frame.BCASTID)} (BCASTID)`,
    authority: "icom_defs.h CTRLID / BCASTID",
    note: civ.frame.defaultRadio === v["icom-civ"].frame.CTRLID
      ? `falls back to ${fmtByte(civ.frame.defaultRadio)}, which icom_defs.h defines as the ` +
        "controller's own address — no radio answers a frame addressed to a controller"
      : null,
  });

  // Yaesu 5-byte: each opcode against the ncmd[] row that names it.
  const y5 = webham.commands["yaesu-5byte"];
  const NCMD = [
    ["setFreq", y5.setFreq.opcode, "set freq"],
    ["readAll", y5.readAll.opcode, "get FREQ and MODE status"],
    ["setMode", y5.setMode.opcode, "mode set main LSB"],
    ["pttOn", y5.pttOn.opcode, "ptt on"],
    ["pttOff", y5.pttOff.opcode, "ptt off"],
  ];
  for (const [op, actual, label] of NCMD) {
    const row = v["yaesu-5byte"].ncmd.find((r) => r.label === label);
    const expected = row?.bytes[4];
    push({
      key: `command/yaesu-5byte/${op}`, area: "command", subject: "yaesu-5byte", field: op,
      verdict: expected === undefined ? "unverifiable" : expected === actual ? "agrees" : "diverges",
      webham: fmtByte(actual), hamlib: expected === undefined ? null : fmtByte(expected),
      authority: `ft897.c ncmd[] "${label}"`,
      note: expected === undefined ? `ncmd[] no longer has a row labelled "${label}"` : null,
    });
  }

  // ASCII protocols: WebHam's rendered command against the template derived from
  // upstream's own literal.
  for (const [protocol, spec] of Object.entries(COMMAND_AUTHORITY)) {
    const cmds = webham.commands[protocol];
    const ops = v[spec.vocab]?.ops;
    // Every mode value that can reach this protocol, so setMode is checked against
    // the real thing rather than a placeholder. Kenwood's are one character and
    // newcat's are two, which is exactly the difference the templates encode.
    const modeValues = Object.values(webham.families)
      .filter((f) => f.protocol === protocol)
      .flatMap((f) => f.modes.map((m) => m.value));
    for (const [op, rule] of Object.entries(spec.ops)) {
      const key = `command/${protocol}/${op}`;
      // CAT_COMMANDS names operations pttOn/pttOff; upstream implements both in one
      // function, so `from` says which snapshot op holds the literals.
      const vocabOp = rule.from ?? op;
      const cited = ops?.[vocabOp]?.literals ?? [];
      // The citation check. If the literal this template was read from is gone,
      // the template is unbacked and must not be trusted to pass or fail.
      if (!cited.includes(rule.cite)) {
        push({ key, area: "command", subject: protocol, field: op, verdict: "unverifiable",
               webham: renderCommand(cmds[op], modeValues[0]), hamlib: rule.describe,
               authority: `${spec.vocab} ops.${vocabOp}`,
               note: `citation lost: ${ops?.[vocabOp]?.fn ?? "function"} no longer contains the literal ` +
                     `"${rule.cite}" this template was derived from — re-derive it before trusting this row` });
        continue;
      }
      // A parameterised command is rendered once per argument it can carry, and
      // every rendering has to match: one bad mode value is one bad command.
      const args = op === "setMode" ? modeValues : [null];
      const rendered = args.map((arg) => renderCommand(cmds[op], arg));
      const bad = rendered.filter((s) => !rule.expect.test(s.replace(/;$/, "")));
      push({
        key, area: "command", subject: protocol, field: op,
        verdict: bad.length ? "diverges" : "agrees",
        webham: [...new Set(rendered)].join(" "),
        hamlib: rule.describe, authority: `${spec.vocab} ${ops[vocabOp].fn} "${rule.cite}"`,
        note: bad.length
          ? `WebHam sends "${[...new Set(bad)].join('" "')}" where upstream sends ${rule.describe}`
          : null,
      });
    }
  }
  for (const [protocol, why] of Object.entries(UNVERIFIED_COMMAND_PROTOCOLS)) {
    if (!webham.commands[protocol]) continue;
    push({ key: `command/${protocol}`, area: "command", subject: protocol, field: "(all operations)",
           verdict: "unverifiable", webham: null, hamlib: null, authority: null, note: why });
  }
  // Every protocol WebHam can speak must be either compared or excused.
  for (const protocol of Object.keys(webham.commands)) {
    if (COMMAND_AUTHORITY[protocol] || UNVERIFIED_COMMAND_PROTOCOLS[protocol]) continue;
    if (DIRECT_COMMAND_PROTOCOLS.has(protocol)) continue;
    push({ key: `command/${protocol}`, area: "command", subject: protocol, field: "(all operations)",
           verdict: "diverges", webham: null, hamlib: null, authority: null,
           note: "protocol is neither compared against Hamlib nor listed in UNVERIFIED_COMMAND_PROTOCOLS" });
  }

  // ── 4. per-rig Icom CI-V data ─────────────────────────────────────────────
  //
  // This is capability, not vocabulary: each Icom carries its own bus address and
  // its own frequency-encoding width, and neither is currently in WebHam at all.
  const byToken = new Map(snapshot.rigs.map((r) => [r.modelToken, r]));
  const byId = new Map(snapshot.rigs.map((r) => [r.id, r]));
  for (const [id, spec] of Object.entries(webham.generatedSpecs)) {
    const rig = byId.get(id);
    // A profile in an Icom family with no upstream priv_caps has no address to
    // compare against, and that is worth saying: it is the case where the CI-V
    // fallback still applies and the user has to supply the address by hand.
    const isCiv = webham.families[spec.family]?.protocol === "icom-civ";
    if (isCiv && !rig?.icom) {
      push({
        key: `civ-addr/${id}`, area: "civ-addr", subject: `${id} ${spec.name}`, field: "re_civ_addr",
        verdict: "unverifiable", webham: spec.civAddr === undefined ? "none (falls back)" : fmtByte(spec.civAddr),
        hamlib: null, authority: rig ? `no icom_priv_caps in ${rig.file}` : "not a Hamlib model",
        note: "Hamlib declares no CI-V address for this rig, so WebHam cannot import one — " +
              "the operator has to enter it in Settings before CAT will reach the radio",
      });
      continue;
    }
    if (!rig?.icom) continue;
    push({
      key: `civ-addr/${id}`, area: "civ-addr", subject: `${id} ${spec.name}`, field: "re_civ_addr",
      verdict: spec.civAddr === rig.icom.civAddr ? "agrees" : spec.civAddr === undefined ? "hamlib-only" : "diverges",
      webham: spec.civAddr === undefined ? null : fmtByte(spec.civAddr),
      hamlib: fmtByte(rig.icom.civAddr),
      authority: `icom_priv_caps in ${rig.file}`,
      note: spec.civAddr === rig.icom.civAddr ? null : "the rig's own CI-V bus address",
    });
    if (rig.icom.mode731) {
      push({
        key: `civ-731/${id}`, area: "civ-731", subject: `${id} ${spec.name}`, field: "civ_731_mode",
        verdict: spec.civ731 === true ? "agrees" : "hamlib-only",
        webham: spec.civ731 === true ? "8 BCD digits (4 bytes)" : "10 BCD digits (5 bytes)",
        hamlib: "8 BCD digits (4 bytes)",
        authority: `icom_priv_caps in ${rig.file}`,
        note: spec.civ731 === true
          ? null
          : "731-mode rigs take a shorter frequency frame; a 5-byte payload is the wrong length for them",
      });
    }
  }

  // ── 5. per-rig serial parameters ──────────────────────────────────────────
  for (const [id, spec] of Object.entries(webham.generatedSpecs)) {
    const rig = [...byToken.values()].find((r) => r.id === id);
    if (!rig) continue;
    const h = rig.serial;
    const w = spec.serial ?? webham.families[spec.family]?.serial;
    if (!w || !h) continue;
    const subject = `${id} ${spec.name}`;
    const cmp = (field, mine, theirs) => {
      if (!mine || !theirs) return;
      push({
        key: `serial/${id}/${field}`, area: "serial", subject, field,
        verdict: mine === theirs ? "agrees" : "diverges",
        webham: String(mine), hamlib: String(theirs), authority: `rig_caps in ${rig.file}`,
      });
    };
    cmp("dataBits", w.dataBits, h.dataBits);
    cmp("stopBits", w.stopBits, h.stopBits);
    cmp("parity", w.parity, h.parity);
    // Hamlib publishes a supported RANGE; WebHam picks one rate inside it. Only a
    // rate the rig cannot actually accept is a disagreement.
    if (w.baudRate && h.rateMin && h.rateMax) {
      const inRange = w.baudRate >= h.rateMin && w.baudRate <= h.rateMax;
      push({
        key: `serial/${id}/baudRate`, area: "serial", subject, field: "baudRate",
        verdict: inRange ? "agrees" : "diverges",
        webham: String(w.baudRate), hamlib: `${h.rateMin}-${h.rateMax}`,
        authority: `rig_caps in ${rig.file}`,
        note: inRange ? null : `${w.baudRate} is outside the range Hamlib says this rig accepts`,
      });
    }
  }

  const counts = {};
  for (const f of findings) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1;
  return { findings, counts };
}

// Render a CAT_COMMANDS entry as the string it would actually put on the wire, so
// a template can be matched against it. Fixed commands are already strings.
//
// Deliberately mirrors cat.js's asciiFreqCommand/asciiModeCommand rather than
// calling them: the diff has to be able to say what a spec means on its own, and
// importing the formatter it is checking would make the comparison circular.
export function renderCommand(spec, arg = null) {
  if (typeof spec === "string") return spec;
  if (spec?.digits) return `${spec.prefix}${String(SAMPLE_FREQ_HZ).padStart(spec.digits, "0")};`;
  if (spec?.prefix) return `${spec.prefix}${arg ?? ""};`;
  return String(spec);
}

// ── the decisions ledger ─────────────────────────────────────────────────────
//
// Findings that do not agree need a human call, and tools/hamlib-decisions.json
// is where each call is written down. Reconciling the two is what keeps the ledger
// honest: an entry that no longer matches a live finding is as much of a problem
// as a finding nobody has looked at.
export const DECISIONS = {
  "keep-webham": "WebHam's value is correct; Hamlib differs for a stated, understood reason",
  "webham-extra": "WebHam offers something Hamlib does not tabulate, and keeping it is safe",
  "coverage": "Hamlib knows something WebHam does not offer; acknowledged, not adopted",
  "parked": "a real disagreement that needs hardware or an owner decision (requires `followup`)",
};

export function reconcile({ findings, ledger }) {
  const entries = ledger.decisions ?? {};
  const open = [];        // needs a decision
  const stale = [];       // decision for a finding that no longer exists
  const drifted = [];     // finding's verdict changed since it was adjudicated
  const invalid = [];     // malformed entry
  const decidedBy = new Map();  // key -> decision, for the report
  const matched = new Set();    // ledger keys that covered at least one finding

  // A key ending in "/*" covers every finding beneath that prefix; an exact key
  // always wins over a glob. Without this, one decision ("Hamlib publishes a CI-V
  // address per rig and WebHam does not carry one") would need 20 identical ledger
  // entries today and a 21st the moment Hamlib adds an Icom — and a ledger that
  // has to be edited for every upstream addition is one people route around.
  const globs = Object.keys(entries)
    .filter((k) => k.endsWith("/*"))
    .map((k) => [k, k.slice(0, -1)]);
  function entryFor(key) {
    if (entries[key]) return [key, entries[key]];
    for (const [globKey, prefix] of globs) {
      if (key.startsWith(prefix)) return [globKey, entries[globKey]];
    }
    return [null, undefined];
  }

  for (const f of findings) {
    if (f.verdict === "agrees") continue;
    const [ledgerKey, entry] = entryFor(f.key);
    if (!entry) { open.push(f); continue; }
    matched.add(ledgerKey);
    decidedBy.set(f.key, entry.decision);
    if (!DECISIONS[entry.decision]) {
      invalid.push({ key: f.key, why: `unknown decision "${entry.decision}"` });
    } else if (!entry.why) {
      invalid.push({ key: f.key, why: "no `why`" });
    } else if (entry.decision === "parked" && !entry.followup) {
      invalid.push({ key: f.key, why: "parked without a `followup`" });
    }
    // The verdict is recorded at adjudication time so a CHANGED verdict cannot
    // keep coasting on an old decision. Hamlib adding a mode code that WebHam was
    // excused for lacking is exactly the case this catches.
    if (entry.verdict !== f.verdict) {
      drifted.push({ key: f.key, was: entry.verdict, now: f.verdict });
    }
  }
  // Staleness, for globs and exact keys alike: an entry that covered nothing is an
  // entry excusing a problem that no longer exists. Either the field is gone or it
  // now agrees, and both mean the entry should go — an unpruned ledger lies about
  // what is still outstanding.
  const byKey = new Map(findings.map((f) => [f.key, f]));
  for (const key of Object.keys(entries)) {
    if (matched.has(key)) continue;
    if (key.endsWith("/*")) {
      stale.push({ key, why: "matched no finding — nothing under this prefix disagrees any more" });
      continue;
    }
    const f = byKey.get(key);
    if (!f) stale.push({ key, why: "no such finding — the field is gone" });
    else stale.push({ key, why: "now agrees with Hamlib — nothing left to decide" });
  }
  return { open, stale, drifted, invalid, decidedBy };
}

// ── report ───────────────────────────────────────────────────────────────────

const ORDER = ["diverges", "webham-only", "hamlib-only", "unverifiable", "agrees"];

export function formatDiff({ findings, counts, reconciliation, hamlibTag }) {
  const out = [];
  const entries = reconciliation ? new Map() : null;
  out.push(`\n── WebHam vs Hamlib ${hamlibTag}: CAT data diff ──────────────────────`);
  out.push(`  ${String(findings.length).padStart(4)}  fields compared`);
  for (const verdict of ORDER) {
    if (!counts[verdict]) continue;
    out.push(`  ${String(counts[verdict]).padStart(4)}  ${verdict}`);
  }
  out.push(
    `\n  ${counts.agrees ?? 0} of ${findings.length} fields already match Hamlib. Those are kept as they are;` +
    `\n  nothing below is changed automatically.`
  );

  // Group the non-agreeing findings by area so the report reads like a review
  // rather than a flat log.
  const interesting = findings.filter((f) => f.verdict !== "agrees");
  const byArea = new Map();
  for (const f of interesting) {
    if (!byArea.has(f.area)) byArea.set(f.area, []);
    byArea.get(f.area).push(f);
  }
  for (const [area, list] of byArea) {
    out.push(`\n  ${area} (${list.length})`);
    const shown = list.slice(0, 12);
    for (const f of shown) {
      const decided = reconciliation?.decidedBy?.get(f.key);
      const mark = decided ? `[${decided}]` : "[OPEN]";
      out.push(`    ${mark} ${f.subject} ${f.field}: ${f.verdict}`);
      if (f.webham !== null || f.hamlib !== null) {
        out.push(`           WebHam ${f.webham ?? "—"}  |  Hamlib ${f.hamlib ?? "—"}`);
      }
      if (f.note) out.push(`           ${f.note}`);
    }
    if (list.length > shown.length) out.push(`    … and ${list.length - shown.length} more`);
  }

  if (reconciliation) {
    const { open, stale, drifted, invalid } = reconciliation;
    out.push(`\n── ledger (tools/hamlib-decisions.json) ─────────────────────────────`);
    out.push(`  ${String(open.length).padStart(4)}  undecided`);
    out.push(`  ${String(stale.length).padStart(4)}  stale entries`);
    out.push(`  ${String(drifted.length).padStart(4)}  verdict changed since adjudication`);
    out.push(`  ${String(invalid.length).padStart(4)}  malformed entries`);
    for (const f of open) out.push(`    ? ${f.key}`);
    for (const s of stale) out.push(`    - ${s.key}: ${s.why}`);
    for (const d of drifted) out.push(`    ! ${d.key}: recorded as ${d.was}, now ${d.now}`);
    for (const i of invalid) out.push(`    x ${i.key}: ${i.why}`);
  }
  out.push("");
  return out.join("\n");
}
