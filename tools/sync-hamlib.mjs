#!/usr/bin/env node
// Regenerate the WebHam rig catalogue from Hamlib's own rig definitions.
//
//   node tools/sync-hamlib.mjs --refresh   fetch Hamlib, rewrite the snapshot, report drift
//   node tools/sync-hamlib.mjs --build     snapshot + map -> rigs-generated.js       (offline)
//   node tools/sync-hamlib.mjs --check     rebuild and diff against rigs-generated.js (offline)
//   node tools/sync-hamlib.mjs --report    print the drift report from the snapshot   (offline)
//   node tools/sync-hamlib.mjs --diff      per-field WebHam-vs-Hamlib CAT diff        (offline)
//
// Same three-file discipline as tools/sync-contests.mjs, for the same reason:
//
//   hamlib-sources.json  every fact taken from Hamlib, verbatim, pinned to one
//                        release tag. --refresh rewrites it straight from the
//                        network, so a changed upstream value shows up as a diff
//                        against the source rather than a silent behaviour change.
//
//   hamlib-map.json      the hand-decided part: which Hamlib backend maps to
//                        which WebHam protocol family, plus per-model exceptions.
//                        Reviewed once, re-applied mechanically forever.
//
//   rigs-generated.js    generated. Do not hand-edit; run --build.
//
// WHAT HAMLIB DOES AND DOES NOT GIVE US — the whole design rests on this:
//
// Hamlib's `struct rig_caps` is data: model number, model name, manufacturer,
// port type, and the default serial line settings. All of that imports cleanly.
//
// The CAT protocol splits in two, and the split is the important part:
//
//   The command VOCABULARY is data. Opcodes, mode codes, frame constants, the
//   per-rig CI-V address, the literal command strings — all of it sits in the C
//   source as #defines, designated-initializer tables, and string literals. It
//   is extracted here (see `parseIcomDefs` and friends) into the snapshot's
//   `vocabulary`, and that is what makes Hamlib checkable against WebHam.
//
//   The TRANSACTION LAYER is not data. VFO resolution, redundant-set
//   suppression, response validation, retries, per-rig quirks and sleeps are
//   control flow in C functions. WebHam implements its own, and no import can
//   change that.
//
// So a rig is only ever emitted when the map says WebHam has a protocol family
// that can actually drive it. Everything else is reported, never guessed —
// emitting an unmapped rig would put a name in the picker that fails on connect,
// which is worse than omitting it.
//
// NOTHING IS OVERWRITTEN AUTOMATICALLY. WebHam's CAT tables were written by hand
// and many of them are right; Hamlib is a second opinion, not a patch. --diff
// (tools/hamlib-diff.mjs) compares the two field by field and classifies every
// difference; tools/hamlib-decisions.json records the human call on each one.
// Values that agree need no entry and no action — that is the common case, and
// the point. An automated import must never silently change a baud rate or a
// mode byte someone confirmed on hardware.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SNAPSHOT = join(HERE, "hamlib-sources.json");
const MAP = join(HERE, "hamlib-map.json");
const DECISIONS = join(HERE, "hamlib-decisions.json");
const OUTPUT = join(ROOT, "js", "connectors", "rigs-generated.js");
const CACHE = join(HERE, ".cache");

// The Hamlib release this catalogue was built from. Recorded in the snapshot
// (hamlib-sources.json's `hamlibTag`) rather than hard-coded here, so the
// version in play is data you can see in a diff. This constant is only the
// bootstrap value for a first-ever refresh.
const DEFAULT_HAMLIB_TAG = "4.6.2";

// Resolved at startup: the recorded tag, or --latest's newly-resolved one.
let hamlibTag = DEFAULT_HAMLIB_TAG;

const RAW = (p) => `https://raw.githubusercontent.com/Hamlib/Hamlib/${hamlibTag}/${p}`;

// Hamlib publishes its releases on SourceForge, and this endpoint names the
// current one — the authoritative source for "latest release", and reachable
// without a GitHub API token. Deliberately NOT `master`: master self-reports
// 5.0.0~git, i.e. unreleased and in flux, so tracking it would ship
// half-finished upstream rig data into people's radio configs.
const HAMLIB_LATEST_URL = "https://sourceforge.net/projects/hamlib/best_release.json";

// Only backends WebHam has a protocol family for. Hamlib ships ~384 models
// across ~40 backends; the rest (AOR, TenTec, Uniden, WinRadio, KIT…) would need
// new protocol implementations, which is a separate project.
const BACKENDS = ["yaesu", "kenwood", "icom", "flexradio"];

// ── fetch helpers ────────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "WebHam-sync-hamlib/1.0 (+https://github.com/rfvx/WebHam)" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// The tag recorded in the committed snapshot, so `--refresh` keeps rebuilding
// from the same upstream release until someone deliberately moves it.
async function recordedTag() {
  if (!existsSync(SNAPSHOT)) return DEFAULT_HAMLIB_TAG;
  try {
    return JSON.parse(await readFile(SNAPSHOT, "utf8")).hamlibTag || DEFAULT_HAMLIB_TAG;
  } catch {
    return DEFAULT_HAMLIB_TAG;
  }
}

// SourceForge names releases by directory ("/hamlib/4.7.2/hamlib-w64-4.7.2.exe").
export function parseLatestVersion(json) {
  const filename = json?.release?.filename || "";
  const m = /^\/hamlib\/(\d+(?:\.\d+)+)\//.exec(filename);
  return m ? m[1] : null;
}

// Resolve Hamlib's current release, then prove that tag actually exists on the
// GitHub mirror we fetch sources from before committing to it: a release can be
// published on SourceForge before (or without) a matching git tag, and every
// source fetch would then 404 one file at a time instead of failing clearly.
async function resolveLatestTag() {
  const version = parseLatestVersion(JSON.parse(await fetchText(HAMLIB_LATEST_URL)));
  if (!version) throw new Error(`could not read a version out of ${HAMLIB_LATEST_URL}`);
  const probe = await fetch(
    `https://raw.githubusercontent.com/Hamlib/Hamlib/${version}/include/hamlib/riglist.h`,
    { headers: { "User-Agent": "WebHam-sync-hamlib/1.0" } }
  );
  if (!probe.ok) {
    throw new Error(
      `Hamlib ${version} is the current release, but tag "${version}" is not on the GitHub ` +
      `mirror yet (HTTP ${probe.status}). Re-run once it is tagged.`
    );
  }
  return version;
}

// Cache raw upstream files so re-running --refresh while iterating on the parser
// does not re-hit the network 180 times. Keyed by tag, so switching releases
// never serves the previous release's sources.
async function cachedFetch(path) {
  const safe = path.replace(/[/.]/g, "_");
  const file = join(CACHE, `${hamlibTag}__${safe}`);
  if (existsSync(file)) return readFile(file, "utf8");
  const text = await fetchText(RAW(path));
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, text);
  return text;
}

// ── riglist.h: RIG_MODEL_* -> number ─────────────────────────────────────────

// riglist.h is plain #defines over one arithmetic macro:
//   #define MAX_MODELS_PER_BACKEND 1000
//   #define RIG_MAKE_MODEL(a,b) (MAX_MODELS_PER_BACKEND*(a)+(b))
//   #define RIG_YAESU 1
//   #define RIG_MODEL_FT897 RIG_MAKE_MODEL(RIG_YAESU, 23)
// so FT-897 is 1023 — which is already the id WebHam uses for it. The existing
// catalogue was numbered on this scheme, which is why this import lines up with
// it instead of renumbering anything.
export function parseRigList(header) {
  const perBackend = Number(header.match(/#define\s+MAX_MODELS_PER_BACKEND\s+(\d+)/)?.[1]);
  if (!Number.isFinite(perBackend)) throw new Error("riglist.h: MAX_MODELS_PER_BACKEND not found");

  const backendNums = new Map();
  for (const m of header.matchAll(/^#define\s+RIG_([A-Z0-9_]+)\s+(\d+)\s*$/gm)) {
    // Backend ids only: RIG_YAESU 1. Excludes RIG_MODEL_* (which use the macro)
    // and RIG_BACKEND_LIST-style text.
    if (!m[1].startsWith("MODEL_")) backendNums.set(m[1], Number(m[2]));
  }

  const models = new Map();
  const unresolved = [];
  for (const m of header.matchAll(
    /^#define\s+(RIG_MODEL_[A-Z0-9_]+)\s+RIG_MAKE_MODEL\(\s*RIG_([A-Z0-9_]+)\s*,\s*(\d+)\s*\)/gm
  )) {
    const [, name, backend, index] = m;
    const backendNum = backendNums.get(backend);
    if (backendNum === undefined) {
      unresolved.push({ name, backend });
      continue;
    }
    models.set(name, {
      id: String(perBackend * backendNum + Number(index)),
      backend: backend.toLowerCase(),
    });
  }
  return { perBackend, models, unresolved };
}

// ── protocol vocabulary ──────────────────────────────────────────────────────
//
// The correction to this file's original premise. "The CAT protocol is C
// functions, not data" is true of the *transaction layer* — VFO resolution,
// redundant-set suppression, per-rig quirks, response validation, retries — but
// false of the *command vocabulary*, which is literal data in the C source:
//
//   rigs/icom/icom_defs.h   41 C_* command opcodes and the S_* mode codes,
//                           as plain #defines
//   rigs/yaesu/ft897.c      the ncmd[] table: every 5-byte frame as literal
//                           hex with a comment naming it
//   rigs/kenwood/kenwood.c  a designated-initializer array mapping the MD
//                           digit to a mode
//
// WebHam issues five commands (set/read frequency, set/read mode, PTT), and the
// vocabulary for all five is extractable. Importing it makes upstream the source
// of truth for the bytes, which is what caught the icom-civ mode table being one
// code high on every mode.

const hex = (v) => Number.parseInt(v, 16);

// Icom CI-V: C_* are command opcodes, S_* are sub-command/mode codes.
export function parseIcomDefs(header) {
  const commands = {};
  const modes = {};
  const subCommands = {};
  // The frame constants. WebHam hard-codes 0xFE/0xFD/0xE1 in buildCivPacket, and
  // these are what say whether those are the right numbers — CTRLID in
  // particular is the *controller's* address, which is not the same thing as a
  // default address to send TO.
  const frame = {};
  for (const name of ["PR", "CTRLID", "BCASTID", "FI", "ACK", "NAK", "COL", "PAD"]) {
    const m = header.match(new RegExp(`^#define\\s+${name}\\s+0x([0-9a-fA-F]+)`, "m"));
    if (m) frame[name] = hex(m[1]);
  }
  for (const m of header.matchAll(/^#define\s+S_([A-Z0-9_]+)\s+0x([0-9a-fA-F]+)/gm)) subCommands[m[1]] = hex(m[2]);
  for (const m of header.matchAll(/^#define\s+C_([A-Z0-9_]+)\s+0x([0-9a-fA-F]+)/gm)) commands[m[1]] = hex(m[2]);
  // S_* covers far more than modes — sub-commands, levels, meters, scan and
  // memory selectors all share the prefix. The mode codes are the ones whose
  // comment reads "Set to <mode>", which is how icom_defs.h distinguishes them
  // (`#define S_LSB 0x00  /* Set to LSB */`). Matching on the prefix alone pulls
  // ~250 unrelated constants into the mode table.
  for (const m of header.matchAll(/^#define\s+S_([A-Z0-9_]+)\s+0x([0-9a-fA-F]+)\s*\/\*\s*Set to /gm)) {
    modes[m[1]] = hex(m[2]);
  }
  if (!Object.keys(commands).length) throw new Error("icom_defs.h: no C_* command defines found");
  if (!Object.keys(modes).length) throw new Error("icom_defs.h: no 'Set to <mode>' S_* defines found");
  if (!Object.keys(frame).length) throw new Error("icom_defs.h: no CI-V frame constants found");
  return { commands, modes, subCommands, frame };
}

// Per-rig CI-V data, from `static const struct icom_priv_caps <sym> = { 0x94, 0, … }`.
//
// The struct's first two positional members (icom.h) are the two that change what
// goes on the wire:
//   re_civ_addr    the radio's default CI-V address — the `to` byte of every
//                  frame. It differs per model (IC-7300 0x94, IC-705 0xA4), and
//                  without it a controller has to guess.
//   civ_731_mode   off: frequencies are 10 BCD digits (5 bytes); on: 8 digits
//                  (4 bytes). Send five bytes to a 731-mode rig and the frame is
//                  the wrong length.
// Both are positional, not designated, so this reads the first two values after
// the opening brace and stops. Anything that does not match that shape is left
// out rather than guessed at, and shows up as a rig with no `icom` block.
export function parseIcomPrivCaps(source) {
  const out = {};
  for (const m of source.matchAll(
    /static\s+const\s+struct\s+icom_priv_caps\s+([A-Za-z0-9_]+)\s*=\s*\{\s*(0x[0-9a-fA-F]+|\d+)\s*,(?:\s*\/\*[^*]*\*\/)?\s*(\d+)\s*,/g
  )) {
    out[m[1]] = { civAddr: Number(m[2]), mode731: Number(m[3]) === 1 };
  }
  return out;
}

// ── ASCII command strings ────────────────────────────────────────────────────
//
// Kenwood/newcat/Flex commands are ASCII, and the exact string each operation
// sends is a literal inside the C function that implements it. That makes them
// citable even though the surrounding control flow is not importable: slice the
// function body, take the string literals, and you have upstream's own answer to
// "what does set_ptt actually put on the wire".
//
// Recorded verbatim, printf specifiers and all. Interpreting them (matching
// `MD%c%c` against WebHam's `MD;`) is the diff engine's job, not the snapshot's.

// `PRIll` and friends are length-modifier macros that sit between two adjacent
// string literals: `"F%c%0*" PRIll ";"` is one format string in C. Joining across
// them is what makes the recorded literal match the real one.
const PRI_MACROS = { PRIll: "lld", PRIu64: "llu", PRIi64: "lli", PRIx64: "llx" };

// Extract C string literals from a slice of source, joining adjacent ones the way
// the C preprocessor does.
export function extractStringLiterals(body) {
  const pieces = [];
  const token = /"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*)|(\S)/g;
  let current = null;
  let m;
  while ((m = token.exec(body))) {
    if (m[1] !== undefined) {
      current = current === null ? m[1] : current + m[1];
      continue;
    }
    // An identifier between two literals continues the concatenation only when it
    // is a known length macro; any other identifier is a variable, which ends it.
    if (m[2] !== undefined && current !== null && PRI_MACROS[m[2]]) {
      current += PRI_MACROS[m[2]];
      continue;
    }
    if (current !== null) {
      pieces.push(current);
      current = null;
    }
  }
  if (current !== null) pieces.push(current);
  return pieces;
}

// Slice a named C function body: `int newcat_set_ptt(…)\n{ … \n}`.
//
// Deliberately NOT brace-matched. Brace matching needs a real C lexer, because an
// apostrophe in an ordinary comment ("don't") opens a fake character literal and
// every brace after it is swallowed — which is how the first version of this
// silently returned all of newcat.c for set_ptt and nothing at all for set_freq.
// Hamlib is uniformly formatted with the closing brace of a top-level function in
// column 0, so the first "\n}" after the opening brace ends the body. That
// assumption is checkable: parseAsciiOps reports a `missing` op if the function
// cannot be found, and the diff reports an op whose literal list came back empty.
//
// A prototype (`int newcat_set_freq(…);`) has no brace after the parameter list,
// so requiring one lands on the definition.
function functionBody(source, name) {
  const decl = new RegExp(`\\b${name}\\s*\\([^;{}]*\\)\\s*\\n?\\s*\\{`, "g");
  const m = decl.exec(source);
  if (!m) return null;
  const end = source.indexOf("\n}", decl.lastIndex);
  return source.slice(decl.lastIndex, end === -1 ? source.length : end);
}

// `newcat_valid_command(rig, "TX")` asks whether a rig supports a command; the
// literal is a capability probe, not something sent. Leaving those in would make
// every backend look like it sends the bare two-letter token, which is exactly
// the mistake this diff exists to catch.
function probeArguments(body) {
  const probes = new Set();
  for (const m of body.matchAll(/valid_command\s*\([^,]*,\s*"([^"]*)"/g)) probes.add(m[1]);
  return probes;
}

// ops: { operationName: cFunctionName }. Returns, per operation, the literals
// that function contains, or a `missing` marker so a renamed upstream function
// is reported rather than silently yielding an empty list.
export function parseAsciiOps(source, ops) {
  const out = {};
  for (const [op, fnName] of Object.entries(ops)) {
    const body = functionBody(source, fnName);
    if (body === null) {
      out[op] = { fn: fnName, missing: true, literals: [] };
      continue;
    }
    const probes = probeArguments(body);
    const literals = extractStringLiterals(body)
      .filter((s) => s.length && !probes.has(s) && s !== "NULL")
      // A command is uppercase letters, optionally ZZ-prefixed, optionally with
      // printf specifiers — `MD%c`, `TX1;`, `RX`, and `F%c` (get_freq builds the
      // VFO letter as an argument, so only one literal capital survives).
      //
      // Debug and error strings are what this excludes, and the space is what
      // does it: every CAT command in these backends is contiguous, while
      // "TX ON" and "SPLIT = %d, vfo = %s\n" are prose.
      .filter((s) => /^(?:ZZ)?[A-Z][A-Z%$0-9]/.test(s) && !/[\s\\]/.test(s));
    out[op] = { fn: fnName, literals: [...new Set(literals)] };
  }
  return out;
}

// Yaesu 5-byte: rows are `{ needsReply, {b0..b4} }, /* label */`. The trailing
// comment is the only thing naming each frame, so it is the key — brittle by
// nature, which is why the map pins the exact labels it depends on and --build
// fails loudly if one stops matching.
export function parseYaesuNcmd(source) {
  const block = source.match(/static const yaesu_cmd_set_t ncmd\[\][\s\S]*?\n\};/);
  if (!block) throw new Error("ncmd[] table not found");
  const rows = [];
  for (const m of block[0].matchAll(
    /\{\s*(\d)\s*,\s*\{\s*((?:0x[0-9a-fA-F]{2}\s*,\s*){4}0x[0-9a-fA-F]{2})\s*\}\s*\}\s*,?\s*\/\*\s*(.*?)\s*\*\//g
  )) {
    rows.push({
      label: m[3].trim(),
      needsReply: m[1] === "1",
      bytes: m[2].split(",").map((b) => hex(b.trim())),
    });
  }
  if (!rows.length) throw new Error("ncmd[] table matched but no rows parsed");
  return rows;
}

// Yaesu newcat (FT-450/950/991/DX-10/…): `{ RIG_MODE_X, 'c', bool }`, where 'c'
// is the character sent in `MD0<c>;`. Note the codes are NOT the same as
// Kenwood's digits even though both protocols spell the command "MD" — newcat
// puts RTTY on '6' where Kenwood puts it on '6' too, but newcat's FM is '4'
// against Kenwood's '4'… they agree here, but they diverge above '7', so the two
// tables must stay separate.
export function parseNewcatModes(source) {
  const block = source.match(/static const newcat_mode_conv\[\][\s\S]*?\n\};/);
  if (!block) throw new Error("newcat_mode_conv[] table not found");
  const modes = {};
  for (const m of block[0].matchAll(/\{\s*RIG_MODE_([A-Z0-9]+)\s*,\s*'(.)'/g)) modes[m[1]] = m[2];
  if (!Object.keys(modes).length) throw new Error("newcat_mode_conv[] matched but empty");
  return modes;
}

// Kenwood: `[n] = RIG_MODE_X` — n is the digit sent in `MD<n>;`.
export function parseKenwoodModes(source) {
  const block = source.match(/\[0\]\s*=\s*RIG_MODE_NONE[\s\S]*?\n\};/);
  if (!block) throw new Error("kenwood mode table not found");
  const modes = {};
  for (const m of block[0].matchAll(/\[(\d+)\]\s*=\s*RIG_MODE_([A-Z0-9]+)/g)) {
    if (m[2] !== "NONE") modes[m[2]] = Number(m[1]);
  }
  if (!Object.keys(modes).length) throw new Error("kenwood mode table matched but empty");
  return modes;
}

// ── rig_caps parsing ─────────────────────────────────────────────────────────

const PARITY = { RIG_PARITY_NONE: "none", RIG_PARITY_ODD: "odd", RIG_PARITY_EVEN: "even" };
const HANDSHAKE = {
  RIG_HANDSHAKE_NONE: "none",
  RIG_HANDSHAKE_XONXOFF: "none", // Web Serial has no XON/XOFF; closest is none
  RIG_HANDSHAKE_HARDWARE: "hardware",
};

// Split a .c file into `struct rig_caps <name> = { … }` bodies by brace
// matching. A regex cannot do this: the bodies contain nested braces
// (frequency/mode tables) and stringified braces.
function extractCapsBodies(source) {
  const bodies = [];
  const decl = /(?:const\s+)?struct\s+rig_caps\s+([a-z0-9_]+)\s*=\s*\{/g;
  let m;
  while ((m = decl.exec(source))) {
    let depth = 1;
    let i = decl.lastIndex;
    let inStr = null;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      const prev = source[i - 1];
      if (inStr) {
        if (ch === inStr && prev !== "\\") inStr = null;
      } else if (ch === '"' || ch === "'") {
        inStr = ch;
      } else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    bodies.push({ symbol: m[1], body: source.slice(decl.lastIndex, i - 1) });
  }
  return bodies;
}

// Reads only the handful of scalar fields we need, and only when they appear in
// the simple literal form Hamlib actually uses. Anything computed, conditional,
// or macro-indirected is left undefined and surfaces as a parse gap rather than
// being guessed at.
function scalarField(body, field) {
  const m = body.match(new RegExp(`\\.${field}\\s*=\\s*([^,\\n]+?)\\s*,`));
  return m ? m[1].trim() : undefined;
}

export function parseCapsFile(source, fileName) {
  const rigs = [];
  const gaps = [];
  for (const { symbol, body } of extractCapsBodies(source)) {
    // Both spellings occur: the RIG_MODEL(x) wrapper macro and a plain
    // .rig_model = x assignment.
    const modelToken =
      body.match(/RIG_MODEL\(\s*(RIG_MODEL_[A-Z0-9_]+)\s*\)/)?.[1] ||
      body.match(/\.rig_model\s*=\s*(RIG_MODEL_[A-Z0-9_]+)/)?.[1];
    const modelName = body.match(/\.model_name\s*=\s*"([^"]*)"/)?.[1];
    const mfgName = body.match(/\.mfg_name\s*=\s*"([^"]*)"/)?.[1];

    if (!modelToken || !modelName) {
      gaps.push({ file: fileName, symbol, reason: !modelToken ? "no rig_model" : "no model_name" });
      continue;
    }

    const portType = scalarField(body, "port_type");
    const rateMin = Number(scalarField(body, "serial_rate_min"));
    const rateMax = Number(scalarField(body, "serial_rate_max"));
    const dataBits = Number(scalarField(body, "serial_data_bits"));
    const stopBits = Number(scalarField(body, "serial_stop_bits"));
    const parityTok = scalarField(body, "serial_parity");
    const handshakeTok = scalarField(body, "serial_handshake");

    rigs.push({
      modelToken,
      modelName,
      mfgName: mfgName || "",
      file: fileName,
      symbol,
      // `.priv = (void *)&IC7300_priv_caps` — the name of the backend-private
      // caps struct, so refresh() can join a rig to its CI-V address. Icom writes
      // it with an inconsistent space after the `&`.
      privSymbol: body.match(/\.priv\s*=\s*\(\s*void\s*\*\s*\)\s*&\s*([A-Za-z0-9_]+)/)?.[1] ?? null,
      portType: portType || "",
      rigType: scalarField(body, "rig_type") || "",
      serial: {
        rateMin: Number.isFinite(rateMin) ? rateMin : null,
        rateMax: Number.isFinite(rateMax) ? rateMax : null,
        dataBits: Number.isFinite(dataBits) ? dataBits : null,
        stopBits: Number.isFinite(stopBits) ? stopBits : null,
        parity: parityTok ? (PARITY[parityTok] ?? parityTok) : null,
        flowControl: handshakeTok ? (HANDSHAKE[handshakeTok] ?? handshakeTok) : null,
      },
    });
  }
  return { rigs, gaps };
}

// ── refresh ──────────────────────────────────────────────────────────────────

async function refresh() {
  process.stdout.write(`Fetching Hamlib ${hamlibTag}…\n`);
  const { models, unresolved } = parseRigList(await cachedFetch("include/hamlib/riglist.h"));
  process.stdout.write(`  riglist.h: ${models.size} models declared\n`);
  if (unresolved.length) {
    process.stdout.write(`  ! ${unresolved.length} model(s) with an unknown backend id\n`);
  }

  const all = [];
  const gaps = [];
  for (const backend of BACKENDS) {
    const makefile = await cachedFetch(`rigs/${backend}/Makefile.am`);
    const files = [...new Set(makefile.match(/[a-z0-9_]+\.c/g) || [])].sort();
    let found = 0;
    for (const file of files) {
      let source;
      try {
        source = await cachedFetch(`rigs/${backend}/${file}`);
      } catch (error) {
        gaps.push({ file: `${backend}/${file}`, reason: `fetch failed: ${error.message}` });
        continue;
      }
      const parsed = parseCapsFile(source, `${backend}/${file}`);
      gaps.push(...parsed.gaps);
      // icom_priv_caps structs are file-local statics, so the join is within one
      // file — no cross-file symbol resolution needed.
      const privCaps = backend === "icom" ? parseIcomPrivCaps(source) : null;
      for (const rig of parsed.rigs) {
        const resolved = models.get(rig.modelToken);
        if (!resolved) {
          gaps.push({ file: rig.file, symbol: rig.symbol, reason: `${rig.modelToken} not in riglist.h` });
          continue;
        }
        const icom = rig.privSymbol ? privCaps?.[rig.privSymbol] : null;
        all.push({ ...rig, id: resolved.id, backend: resolved.backend, ...(icom ? { icom } : {}) });
        found += 1;
      }
    }
    process.stdout.write(`  ${backend}: ${files.length} files -> ${found} rigs\n`);
  }

  all.sort((a, b) => Number(a.id) - Number(b.id));

  // The command vocabulary, from the files that hold it as data.
  //
  // `ops` names the C function implementing each of the five operations WebHam
  // performs, so the diff can compare WebHam's command strings against the
  // literals upstream actually sends. The operation keys match the ones in
  // cat.js's CAT_COMMANDS.
  const vocabulary = {};
  const VOCAB_SOURCES = [
    ["icom-civ", "rigs/icom/icom_defs.h", (t) => {
      const { commands, modes, subCommands, frame } = parseIcomDefs(t);
      return { frame, commands, subCommands, modeCodes: modes };
    }],
    ["yaesu-5byte", "rigs/yaesu/ft897.c", (t) => ({ ncmd: parseYaesuNcmd(t) })],
    ["kenwood-ascii", "rigs/kenwood/kenwood.c", (t) => ({
      modeDigits: parseKenwoodModes(t),
      ops: parseAsciiOps(t, {
        setFreq: "kenwood_set_freq",
        readFreq: "kenwood_get_freq",
        setMode: "kenwood_set_mode",
        readMode: "kenwood_get_mode",
        setPtt: "kenwood_set_ptt",
      }),
    })],
    ["yaesu-ascii", "rigs/yaesu/newcat.c", (t) => ({
      modeChars: parseNewcatModes(t),
      ops: parseAsciiOps(t, {
        setFreq: "newcat_set_freq",
        readFreq: "newcat_get_freq",
        setMode: "newcat_set_mode",
        readMode: "newcat_get_mode",
        setPtt: "newcat_set_ptt",
      }),
    })],
    // No flex-ascii entry, deliberately. WebHam's flex-ascii family drives
    // SmartSDR CAT — the virtual COM port that emulates a Kenwood with
    // ZZ-prefixed commands. Hamlib's flexradio backend drives something else
    // entirely: the SmartSDR TCP API, whose commands are `slice tune 0 14.074`,
    // `xmit 1`, `slice set 0 mode=DIGU`. Different transport, different grammar.
    // Fetching it would produce citations that cannot be compared, so flex-ascii
    // is listed as unverifiable in tools/hamlib-diff.mjs with that reason.
  ];
  for (const [name, path, parse] of VOCAB_SOURCES) {
    try {
      vocabulary[name] = { source: path, ...parse(await cachedFetch(path)) };
    } catch (error) {
      // Loudly, not silently: a vocabulary that stops parsing must not quietly
      // fall back to whatever the last snapshot happened to contain.
      gaps.push({ file: path, reason: `vocabulary parse failed: ${error.message}` });
      process.stdout.write(`  ! ${name}: ${error.message}\n`);
    }
  }
  process.stdout.write(
    `  vocabulary: ${Object.keys(vocabulary).join(", ")}\n`
  );

  const snapshot = {
    // Provenance first: a snapshot whose origin is unclear is not reviewable.
    hamlibTag,
    source: `https://github.com/Hamlib/Hamlib/tree/${hamlibTag}`,
    generatedBy: "tools/sync-hamlib.mjs --refresh",
    backends: BACKENDS,
    rigCount: all.length,
    parseGaps: gaps,
    vocabulary,
    rigs: all,
  };
  await writeFile(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`\nWrote ${SNAPSHOT} (${all.length} rigs, ${gaps.length} parse gaps)\n`);
  return snapshot;
}

// ── build ────────────────────────────────────────────────────────────────────

// Families are keyed by Hamlib's RIG_MODEL_* token, never by model number.
//
// This is load-bearing. WebHam's hand-written catalogue and Hamlib disagree
// about which rig owns which number for 29 models — WebHam's 1024 is the
// FT-817ND (5-byte binary CAT, 4800 8N2) while Hamlib's 1024 is the FT-1000MP
// (ASCII, different rate). Keying on the number would pair one rig's protocol
// family with another rig's name and serial settings, i.e. send the wrong CAT
// bytes to a real radio. The token is the stable identity; the number is
// derived from it.
function familyFor(rig, map) {
  return map.modelFamilies?.[rig.modelToken] ?? map.backendFamilies?.[rig.backend] ?? null;
}

// The map carries "//" comment keys and groups its list fields under `.ids` /
// `.profiles` so each can be documented in place. Read through those wrappers.
const idList = (section) => new Set(section?.ids ?? []);

export function buildCatalogue(snapshot, map) {
  const excluded = idList(map.exclude);
  const nonSerialOk = idList(map.allowNonSerial);
  const civFamilies = new Set(map.civFamilies ?? []);
  const emitted = [];
  const skipped = [];
  // Map errors: a rig Hamlib implements over CI-V that is mapped to a family which
  // does not speak it. That profile cannot work — it would put ASCII on the wire for
  // a radio expecting binary CI-V frames — and it is invisible from the WebHam side
  // alone, because nothing in cat.js knows which radios are CI-V. Found the Ten-Tec
  // Delta II this way, mapped to kenwood-ascii for a rig in rigs/icom/delta2.c.
  const mapErrors = [];
  for (const rig of snapshot.rigs) {
    if (excluded.has(rig.modelToken)) {
      skipped.push({ id: rig.id, name: rig.modelName, reason: "excluded by map" });
      continue;
    }
    const family = familyFor(rig, map);
    if (!family) {
      skipped.push({ id: rig.id, name: rig.modelName, reason: `no family mapped for backend "${rig.backend}"` });
      continue;
    }
    // Hamlib marks non-serial rigs (network/USB) with a different port_type.
    // WebHam drives Web Serial only, so those cannot work — except where the map
    // says a virtual COM port makes them reachable (SmartSDR CAT, PowerSDR).
    if (rig.portType !== "RIG_PORT_SERIAL" && !nonSerialOk.has(rig.modelToken)) {
      skipped.push({ id: rig.id, name: rig.modelName, reason: `port_type ${rig.portType || "unknown"}` });
      continue;
    }
    const speaksCiv = civFamilies.has(family);
    if (rig.icom && !speaksCiv) {
      mapErrors.push(
        `${rig.id} ${rig.mfgName} ${rig.modelName} (${rig.modelToken}) is mapped to "${family}", ` +
        `but Hamlib implements it over CI-V in ${rig.file} (address ` +
        `0x${rig.icom.civAddr.toString(16)}${rig.icom.mode731 ? ", 731 mode" : ""})`
      );
    }
    emitted.push({
      id: rig.id,
      family,
      name: map.nameOverrides?.[rig.modelToken] ?? `${rig.mfgName} ${rig.modelName}`.trim(),
      serial: map.serialOverrides?.[rig.modelToken] ?? null,
      // Per-rig Icom CI-V data, straight from icom_priv_caps. cat.js already read
      // profile.civAddr in buildCivPacket — nothing ever set it, so every Icom fell
      // back to one address for all of them. `civ731` marks the rigs whose
      // frequency frame is 8 BCD digits rather than 10.
      //
      // Emitted only for families that speak CI-V: on any other profile these are
      // fields nothing reads, which reads as support that is not there.
      civAddr: speaksCiv ? rig.icom?.civAddr ?? null : null,
      civ731: speaksCiv && rig.icom?.mode731 ? true : null,
      hamlib: { modelToken: rig.modelToken, serial: rig.serial },
      origin: "hamlib",
    });
  }

  // WebHam-only profiles (see the map's `extras` note): emitted so the generated
  // catalogue stays a superset of the hand-written one and no saved profileId
  // stops resolving.
  for (const [id, extra] of Object.entries(map.extras?.profiles ?? {})) {
    if (excluded.has(id)) continue;
    emitted.push({
      id,
      family: extra.family,
      name: extra.name,
      serial: extra.serial ?? null,
      hamlib: null,
      origin: "webham-extra",
    });
  }

  // Hamlib-numbered rigs first, in numeric order; then the namespaced `wh:`
  // extras alphabetically. Number("wh:…") is NaN, so a plain numeric compare
  // would shuffle them unpredictably and make --check diff against itself.
  emitted.sort((a, b) => {
    const an = Number(a.id), bn = Number(b.id);
    const aNum = Number.isFinite(an), bNum = Number.isFinite(bn);
    if (aNum && bNum) return an - bn;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return { emitted, skipped, mapErrors };
}

// Flatten the map's migration section to the plain { oldId: newId } shape the
// app applies. The map keeps richer entries (rig name, token, reason) so the
// table stays auditable in review; the runtime only needs the mapping.
function migrationTable(map) {
  const out = {};
  for (const [from, entry] of Object.entries(map.migration?.ids ?? {})) {
    out[from] = typeof entry === "string" ? entry : entry.to;
  }
  return out;
}

function renderModule(snapshot, map, emitted) {
  const lines = emitted.map((r) => {
    const serial = r.serial ? `, "serial": ${JSON.stringify(r.serial)}` : "";
    const civAddr = r.civAddr === null || r.civAddr === undefined ? "" : `, "civAddr": ${r.civAddr}`;
    const civ731 = r.civ731 ? `, "civ731": true` : "";
    return `  ${JSON.stringify(r.id)}: { "family": ${JSON.stringify(r.family)}, "name": ${JSON.stringify(r.name)}${serial}${civAddr}${civ731} },`;
  });
  return `// GENERATED FILE — do not hand-edit.
//
// Produced by tools/sync-hamlib.mjs --build from:
//   tools/hamlib-sources.json  (Hamlib ${snapshot.hamlibTag} rig_caps, verbatim)
//   tools/hamlib-map.json      (hand-decided backend -> WebHam family mapping)
//
// Rig ids are Hamlib model numbers (MAX_MODELS_PER_BACKEND * backend + index) —
// e.g. 1023 is RIG_MODEL_FT897, the Yaesu FT-897. Ids prefixed "wh:" are
// WebHam-only profiles Hamlib has no model for; they are namespaced so they can
// never sit on a real Hamlib model number (see tools/hamlib-map.json).
//
// Deliberately DATA ONLY, with no imports: js/connectors/cat.js maps these
// through its own makeProfile(). Emitting makeProfile() calls here instead would
// make this module import cat.js while cat.js imports it — and since the calls
// would run at module-evaluation time, they would hit cat.js's RADIO_FAMILIES
// while it is still in the temporal dead zone.
//
// To change a rig: edit tools/hamlib-map.json and re-run --build. To take new
// upstream data: run --refresh --latest, then --build.

export const HAMLIB_TAG = ${JSON.stringify(snapshot.hamlibTag)};

// old profileId -> new profileId, for the one-time localStorage migration in
// cat.js. Ids absent here never changed. See the migration note in
// tools/hamlib-map.json for why this is not optional.
//
// NOTE: this is a single-lookup table, NOT a chain. It contains swaps — e.g.
// "1015" -> "1024" (WebHam's FT-1000MP takes Hamlib's number for it) alongside
// "1024" -> "wh:yaesu-ft-817nd" (WebHam's FT-817ND vacates that number).
// Applying it repeatedly would walk an FT-1000MP user onto the FT-817ND.
export const RIG_ID_MIGRATION = ${JSON.stringify(migrationTable(map), null, 2)};

export const GENERATED_RIG_SPECS = {
${lines.join("\n")}
};
`;
}

async function build({ write = true } = {}) {
  const snapshot = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  const map = JSON.parse(await readFile(MAP, "utf8"));
  const { emitted, skipped, mapErrors } = buildCatalogue(snapshot, map);
  // A map error means an emitted profile cannot drive its radio. Refusing to write
  // is the right response: a picker entry that fails on connect is worse than the
  // rig being absent, and the map is a one-line fix.
  if (mapErrors.length) {
    throw new Error(
      `${mapErrors.length} protocol-family map error(s) in ${MAP}:\n` +
      mapErrors.map((m) => `  ! ${m}`).join("\n")
    );
  }
  const module = renderModule(snapshot, map, emitted);
  if (write) {
    await writeFile(OUTPUT, module);
    process.stdout.write(`Wrote ${OUTPUT} (${emitted.length} rigs, ${skipped.length} skipped)\n`);
  }
  return { module, emitted, skipped, snapshot, map };
}

async function check() {
  const { module, emitted, skipped } = await build({ write: false });
  if (!existsSync(OUTPUT)) {
    process.stderr.write(`${OUTPUT} does not exist — run --build\n`);
    process.exit(1);
  }
  const current = await readFile(OUTPUT, "utf8");
  if (current !== module) {
    process.stderr.write(
      `${OUTPUT} is out of date with the snapshot + map — run --build.\n` +
        `  (${emitted.length} rigs would be emitted, ${skipped.length} skipped)\n`
    );
    process.exit(1);
  }
  process.stdout.write(`rigs-generated.js is up to date (${emitted.length} rigs, ${skipped.length} skipped)\n`);
}

// ── drift report ─────────────────────────────────────────────────────────────

// The reviewable output of an import: what Hamlib knows that WebHam does not,
// where the two disagree, and what was dropped. Printed by --refresh and
// --report; never acted on automatically.
async function report() {
  const { emitted, skipped, snapshot, map } = await build({ write: false });
  // Baseline = the catalogue currently committed in rigs-generated.js, i.e. what
  // the last --build produced. It used to grep cat.js for makeProfile() calls,
  // which was right while the catalogue was hand-written there; now that cat.js
  // only keeps the four profiles Hamlib cannot describe, that baseline would
  // report every single rig as "new" on every refresh.
  const existingIds = new Set();
  if (existsSync(OUTPUT)) {
    const generated = await readFile(OUTPUT, "utf8");
    for (const m of generated.matchAll(/^\s{2}"([^"]+)":\s*\{\s*"family"/gm)) existingIds.add(m[1]);
  }

  const emittedIds = new Set(emitted.map((r) => r.id));
  const newRigs = emitted.filter((r) => !existingIds.has(r.id));
  const onlyInWebHam = [...existingIds].filter((id) => !emittedIds.has(id));

  const serialDisagreements = [];
  for (const rig of emitted) {
    // WebHam-extra profiles have no Hamlib counterpart to compare against.
    if (!rig.hamlib) continue;
    const h = rig.hamlib.serial;
    const w = rig.serial ?? map.familyDefaults?.[rig.family];
    if (!w || !h) continue;
    const diffs = [];
    // Hamlib publishes a supported range; WebHam picks one rate. Only flag a
    // rate that falls outside the range Hamlib says the rig accepts.
    if (w.baudRate && h.rateMin && h.rateMax && (w.baudRate < h.rateMin || w.baudRate > h.rateMax)) {
      diffs.push(`baudRate ${w.baudRate} outside Hamlib ${h.rateMin}-${h.rateMax}`);
    }
    if (w.dataBits && h.dataBits && w.dataBits !== h.dataBits) diffs.push(`dataBits ${w.dataBits} vs ${h.dataBits}`);
    if (w.stopBits && h.stopBits && w.stopBits !== h.stopBits) diffs.push(`stopBits ${w.stopBits} vs ${h.stopBits}`);
    if (w.parity && h.parity && w.parity !== h.parity) diffs.push(`parity ${w.parity} vs ${h.parity}`);
    if (diffs.length) serialDisagreements.push({ id: rig.id, name: rig.name, diffs });
  }

  const out = [];
  out.push(`\n── Hamlib ${snapshot.hamlibTag} drift report ─────────────────────────────`);
  out.push(`  snapshot rigs (mapped backends): ${snapshot.rigs.length}`);
  out.push(`  would emit:                      ${emitted.length}`);
  out.push(`  already in the catalogue:        ${existingIds.size}`);
  out.push(`\n  NEW in Hamlib, absent from WebHam: ${newRigs.length}`);
  for (const r of newRigs.slice(0, 15)) out.push(`    + ${r.id.padEnd(6)} ${r.name}`);
  if (newRigs.length > 15) out.push(`    … and ${newRigs.length - 15} more`);
  out.push(`\n  In the catalogue but NOT emitted from Hamlib: ${onlyInWebHam.length}`);
  for (const id of onlyInWebHam) {
    const known = snapshot.rigs.find((r) => r.id === id);
    out.push(`    ? ${id.padEnd(6)} ${known ? `skipped (${known.modelName})` : "not a Hamlib model number"}`);
  }
  out.push(`\n  Serial-parameter disagreements: ${serialDisagreements.length}`);
  for (const d of serialDisagreements.slice(0, 15)) {
    out.push(`    ! ${d.id.padEnd(6)} ${d.name}: ${d.diffs.join("; ")}`);
  }
  if (serialDisagreements.length > 15) out.push(`    … and ${serialDisagreements.length - 15} more`);
  out.push(`\n  Skipped (not emitted): ${skipped.length}`);
  const bySkipReason = new Map();
  for (const s of skipped) bySkipReason.set(s.reason, (bySkipReason.get(s.reason) || 0) + 1);
  for (const [reason, n] of [...bySkipReason].sort((a, b) => b[1] - a[1])) {
    out.push(`    ${String(n).padStart(4)}  ${reason}`);
  }
  out.push(`\n  Parse gaps: ${snapshot.parseGaps.length}`);
  for (const g of snapshot.parseGaps.slice(0, 10)) {
    out.push(`    ~ ${g.file}${g.symbol ? ` (${g.symbol})` : ""}: ${g.reason}`);
  }
  if (snapshot.parseGaps.length > 10) out.push(`    … and ${snapshot.parseGaps.length - 10} more`);
  out.push("");
  process.stdout.write(out.join("\n"));
}

// ── diff ─────────────────────────────────────────────────────────────────────

// The per-field WebHam-vs-Hamlib comparison. Lives in tools/hamlib-diff.mjs; this
// only supplies it with the two sides and prints the result.
//
// Imported lazily so --build and --check stay independent of js/connectors/cat.js:
// the diff has to import the shipped module to read the tables that actually ship,
// and a syntax error there should not be able to break catalogue generation.
async function diff() {
  const { diffCatData, collectWebHam, reconcile, formatDiff } = await import("./hamlib-diff.mjs");
  const cat = await import(pathToFileURL(join(ROOT, "js", "connectors", "cat.js")).href);
  const generated = await import(pathToFileURL(OUTPUT).href);

  const snapshot = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  const ledger = JSON.parse(await readFile(DECISIONS, "utf8"));

  const webham = collectWebHam({
    families: cat.RADIO_FAMILIES,
    commands: cat.CAT_COMMANDS,
    // Probed, not read: these tables live inside the functions, and probing checks
    // the behaviour that ships rather than a copy of it.
    decoders: {
      "icom-civ": cat.decodeCivMode,
      "yaesu-5byte": cat.ft897ModeName,
      "kenwood-ascii": cat.decodeKenwoodMode,
      "yaesu-ascii": cat.decodeNewcatMode,
      "flex-ascii": cat.decodeSmartSdrMode,
    },
    profiles: cat.RADIO_PROFILES,
    generatedSpecs: generated.GENERATED_RIG_SPECS,
  });

  const { findings, counts } = diffCatData({ snapshot, webham });
  const reconciliation = reconcile({ findings, ledger });
  process.stdout.write(formatDiff({ findings, counts, reconciliation, hamlibTag: snapshot.hamlibTag }));

  const { open, stale, drifted, invalid } = reconciliation;
  const unresolved = open.length + stale.length + drifted.length + invalid.length;
  if (unresolved) {
    process.stderr.write(
      `\n${unresolved} finding(s) need attention in tools/hamlib-decisions.json.\n` +
      `Either change the value in js/connectors/cat.js so it agrees, or record the decision.\n`
    );
    process.exitCode = 1;
  }
  return { findings, counts, reconciliation };
}

// ── cli ──────────────────────────────────────────────────────────────────────

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const mode = flags.find((a) => a !== "--latest");
const wantLatest = flags.includes("--latest");
// Only act as a CLI when run directly. The parsers and the catalogue builder are
// exported so test-hamlib-sync.mjs can import them; without this guard that
// import would run the CLI, print usage, and exit(2) before a single test ran.
const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  try {
    if (mode === "--refresh") {
      const previous = await recordedTag();
      if (wantLatest) {
        const latest = await resolveLatestTag();
        hamlibTag = latest;
        process.stdout.write(
          latest === previous
            ? `Hamlib ${previous} is already the current release.\n`
            : `Hamlib ${previous} -> ${latest} (current release).\n`
        );
      } else {
        hamlibTag = previous;
      }
      await refresh();
      await report();
      if (wantLatest && hamlibTag !== previous) {
        process.stdout.write(
          `\nRecorded version is now ${hamlibTag}. Review the diff (git diff tools/ js/connectors/rigs-generated.js),\n` +
          `then run --build to regenerate the catalogue.\n`
        );
      }
    } else if (mode === "--build") await build();
    else if (mode === "--check") await check();
    else if (mode === "--report") await report();
    else if (mode === "--diff") await diff();
    else {
      process.stderr.write(
        "usage: sync-hamlib.mjs --refresh [--latest] | --build | --check | --report | --diff\n" +
        "  --latest  resolve Hamlib's current release and record it, instead of\n" +
        "            rebuilding from the version already in hamlib-sources.json\n" +
        "  --diff    compare every WebHam CAT value against Hamlib's and reconcile\n" +
        "            the result against tools/hamlib-decisions.json\n"
      );
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`sync-hamlib: ${error.message}\n`);
    process.exit(1);
  }
}
