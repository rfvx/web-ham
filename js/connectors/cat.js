// CAT connector — the radio. Owns the Web Serial port (and the WebSocket bridge
// to a locally-run rigctld), the rig catalogue, the protocol codecs, and the
// polling loop. DOM-free: every UI reaction is an event on this EventTarget.
//
// Events: "status", "frequency", "mode", "ptt", "disconnect", "serial-log".
// "frequency" and "mode" fire only on staged-tune actions; the live polling
// parsers dispatch "status", so anything that must track the VFO continuously
// listens for that.
//
// Constraints worth knowing before changing anything here:
//
// - RADIO_PROFILES is generated. 107 of the 111 entries come from Hamlib's own
//   rig definitions via tools/sync-hamlib.mjs; only "No Radio" and the three
//   rigctld profiles are hand-written. To change a rig, edit
//   tools/hamlib-map.json and re-run --build — hand-editing rigs-generated.js
//   fails the next --check.
//
// - Rig ids are Hamlib model numbers and are persisted in localStorage, so
//   migrateStoredRigIds() rewrites saved ids exactly once behind a schema
//   marker. The table is a remapping, not a fixed point: applying it twice walks
//   an operator onto a different radio.
//
// - CAT_COMMANDS holds every command byte and command string in one place so
//   tools/hamlib-diff.mjs can check each one against Hamlib. A literal buried in
//   a switch cannot be checked by anything, which is how two mode tables stayed
//   wrong.
//
// - "Does the log follow the live VFO" (getFreqFollow/setFreqFollow and the mode
//   equivalents) lives here because both the radio and logger apps read and
//   write it.
import { formatFrequency, wait, sleep, bytesToHex } from "../utils.js";
import { KEYS } from "./settings.js";
import { GENERATED_RIG_SPECS, RIG_ID_MIGRATION } from "./rigs-generated.js";

export const cat = new EventTarget();

export const RADIO_FAMILIES = {
  "yaesu-5byte": {
    protocol: "yaesu-5byte",
    serial: { baudRate: 4800, dataBits: 8, stopBits: 2, parity: "none", flowControl: "none" },
    modes: [{ value: "01", label: "USB" }, { value: "00", label: "LSB" }, { value: "02", label: "CW" }, { value: "04", label: "AM" }, { value: "08", label: "FM" }, { value: "0A", label: "DIG" }]
  },
  // Mode values are the character sent in `MD0<c>;`, fixed by Yaesu's newcat
  // protocol and tabulated in Hamlib's rigs/yaesu/newcat.c (newcat_mode_conv):
  //   LSB '1'  USB '2'  CW '3'  FM '4'  AM '5'  RTTY '6'  CWR '7'
  //   PKTLSB '8'  RTTYR '9'  PKTFM 'A'  FMN 'B'  PKTUSB 'C'  AMN 'D'
  //
  // FM was "06" in both families, which is RTTY — so asking an FT-991A for FM
  // put it into RTTY. Corrected to "04" from that table.
  //
  // NOTE on `yaesu-ascii-classic`: its rigs (FT-747/757/767/840/890/900/920/
  // 980/990/1000) are NOT newcat in Hamlib — each has its own backend speaking a
  // binary protocol, not an ASCII "MD" command at all. So this family is suspect
  // beyond the mode codes; see FOLLOWUPS.md. The value is corrected here because
  // '4' is right for any rig that does understand MD and no worse for one that
  // does not, but the family still needs a protocol review.
  "yaesu-ascii-classic": {
    protocol: "yaesu-ascii",
    serial: { baudRate: 4800, dataBits: 8, stopBits: 2, parity: "none", flowControl: "none" },
    modes: [{ value: "02", label: "USB" }, { value: "01", label: "LSB" }, { value: "03", label: "CW" }, { value: "04", label: "FM" }, { value: "05", label: "AM" }]
  },
  "yaesu-ascii-modern": {
    protocol: "yaesu-ascii",
    serial: { baudRate: 38400, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [{ value: "02", label: "USB" }, { value: "01", label: "LSB" }, { value: "03", label: "CW-U" }, { value: "07", label: "CW-L" }, { value: "04", label: "FM" }, { value: "05", label: "AM" }, { value: "06", label: "RTTY" }, { value: "0C", label: "DATA-U" }]
  },
  "icom-civ-classic": {
    protocol: "icom-civ",
    serial: { baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [{ value: "00", label: "LSB" }, { value: "01", label: "USB" }, { value: "02", label: "AM" }, { value: "03", label: "CW" }, { value: "04", label: "RTTY" }, { value: "05", label: "FM" }]
  },
  // Mode values are raw CI-V mode codes, sent as the data byte of command 0x06
  // (see setMode's "icom-civ" branch: Number.parseInt(val, 16)). They are fixed
  // by the CI-V spec and identical across the Icom line — Hamlib keeps one table
  // for every Icom backend in rigs/icom/icom_defs.h:
  //   S_LSB 0x00, S_USB 0x01, S_AM 0x02, S_CW 0x03, S_RTTY 0x04, S_FM 0x05,
  //   S_WFM 0x06, S_CWR 0x07, S_RTTYR 0x08, S_DSTAR 0x17
  //
  // This table used to read 01/02/03/04/05/06 for LSB..FM — every mode one code
  // high, so an IC-7300 asked for USB was sent 0x02 and went to AM, CW went to
  // RTTY, and FM went to Wide FM. DV was already correct at 0x17, which is what
  // gives the off-by-one away: the table was meant to hold raw CI-V codes all
  // along. Affected the IC-7100/7200/7300/7610/9700/705.
  //
  // Only the default baud rate distinguishes this family from icom-civ-classic;
  // the protocol and mode codes are the same.
  "icom-civ-modern": {
    protocol: "icom-civ",
    serial: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [{ value: "00", label: "LSB" }, { value: "01", label: "USB" }, { value: "02", label: "AM" }, { value: "03", label: "CW" }, { value: "04", label: "RTTY" }, { value: "05", label: "FM" }, { value: "17", label: "DV" }]
  },
  "kenwood-ascii": {
    protocol: "kenwood-ascii",
    serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [{ value: "1", label: "LSB" }, { value: "2", label: "USB" }, { value: "3", label: "CW" }, { value: "4", label: "FM" }, { value: "5", label: "AM" }]
  },
  "elecraft-ascii": {
    protocol: "kenwood-ascii",
    serial: { baudRate: 38400, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [{ value: "1", label: "LSB" }, { value: "2", label: "USB" }, { value: "3", label: "CW" }, { value: "4", label: "FM" }, { value: "5", label: "AM" }, { value: "6", label: "DATA" }]
  },
  "flex-ascii": {
    protocol: "flex-ascii",
    serial: { baudRate: 38400, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [{ value: "0", label: "LSB" }, { value: "1", label: "USB" }, { value: "2", label: "AM" }, { value: "3", label: "CW" }, { value: "4", label: "DIGL" }, { value: "5", label: "DIGU" }, { value: "6", label: "FM" }],
    setupHint: "Use SmartSDR CAT to create a Kenwood-style serial port."
  },
  // Hamlib rigctld, reached over a WebSocket bridge rather than Web Serial (a
  // browser tab cannot open the raw TCP socket rigctld listens on — see the
  // PR #39 research). `transport: "websocket"` routes connect/read/write to the
  // rigctld line-protocol path instead of the serial path. Modes are rigctld's
  // own tokens (Hamlib normalises them across every backend), so `value` IS the
  // token sent in `M <mode> <passband>`. The serial block is vestigial for this
  // family but kept so anything reading profile.serial stays null-safe.
  "hamlib-rigctld": {
    protocol: "rigctld",
    transport: "websocket",
    serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
    modes: [
      { value: "LSB", label: "LSB" }, { value: "USB", label: "USB" },
      { value: "CW", label: "CW" }, { value: "CWR", label: "CW-R" },
      { value: "RTTY", label: "RTTY" }, { value: "RTTYR", label: "RTTY-R" },
      { value: "AM", label: "AM" }, { value: "FM", label: "FM" },
      { value: "PKTUSB", label: "PKT-U" }, { value: "PKTLSB", label: "PKT-L" }
    ],
    setupHint: "Run rigctld and bridge its TCP port to a WebSocket (e.g. websockify 8073 localhost:4532). Set the bridge URL in Settings."
  }
};

// Every command byte and command string WebHam puts on the wire, declared once.
//
// These used to be literals scattered through setFrequency/setMode/setPtt/poll.
// Collecting them here is not tidying: it makes them DATA, which is what lets
// tools/hamlib-diff.mjs compare each one against Hamlib's own value and say
// whether WebHam agrees. A literal buried in a switch cannot be checked by
// anything, and two of WebHam's mode tables were wrong for exactly that reason.
//
// Keyed by `protocol`, not by family — several families share one protocol.
// Run `node tools/sync-hamlib.mjs --diff` after changing anything here.
export const CAT_COMMANDS = {
  // Yaesu 5-byte binary: every frame is {p1,p2,p3,p4,opcode}. Verified against
  // Hamlib's rigs/yaesu/ft897.c ncmd[] table.
  "yaesu-5byte": {
    setFreq: { opcode: 0x01 },   // ncmd "set freq"
    readAll: { opcode: 0x03 },   // ncmd "get FREQ and MODE status"
    setMode: { opcode: 0x07 },   // ncmd "mode set main …", mode code in p1
    pttOn: { opcode: 0x08 },     // ncmd "ptt on"
    pttOff: { opcode: 0x88 }     // ncmd "ptt off"
  },
  // Icom CI-V. Opcodes are icom_defs.h's C_* constants; the frame bytes are its
  // PR / FI. `controller` is the `from` address WebHam signs frames with, and
  // `defaultRadio` the `to` address used when a rig carries no CI-V address.
  //
  // `defaultRadio` was 0xE0, which icom_defs.h defines as CTRLID — the
  // *controller's* address. A frame addressed to 0xE0 is addressed to another
  // controller, so no radio answered it, and nothing ever set profile.civAddr:
  // every Icom needed the CI-V address typed in by hand before CAT worked at all.
  // Each rig now carries its own address (Hamlib's icom_priv_caps.re_civ_addr), so
  // this fallback only applies to the few models Hamlib gives no priv_caps for. It
  // is BCASTID, the CI-V broadcast address, which transceivers do answer — the
  // right value for "address unknown", and from the same header.
  "icom-civ": {
    frame: { preamble: 0xFE, terminator: 0xFD, controller: 0xE1, defaultRadio: 0x00 },
    readFreq: { cmd: 0x03 },                                   // C_RD_FREQ
    readMode: { cmd: 0x04 },                                   // C_RD_MODE
    setFreq: { cmd: 0x05 },                                    // C_SET_FREQ
    setMode: { cmd: 0x06 },                                    // C_SET_MODE
    ptt: { cmd: 0x1C, sub: 0x00, on: 0x01, off: 0x00 }         // C_CTL_PTT / S_PTT
  },
  // Kenwood ASCII. `digits` is the zero-padded width of the frequency argument;
  // setMode takes the mode value verbatim (a single digit for Kenwood).
  "kenwood-ascii": {
    setFreq: { prefix: "FA", digits: 11 },
    readFreq: "FA;",
    setMode: { prefix: "MD" },
    readMode: "MD;",
    pttOn: "TX;",
    pttOff: "RX;"
  },
  // Yaesu newcat ASCII. NOT Kenwood's command set, which is what these three
  // values assumed until `--diff` compared them against rigs/yaesu/newcat.c:
  //
  //   pttOn/pttOff were "TX;"/"RX;". newcat_set_ptt sends TX1; to transmit and
  //   TX0; to receive. On a newcat rig "TX;" is the command that *reads* TX
  //   status and "RX;" is not a command at all — so PTT over CAT never keyed the
  //   radio on any Yaesu ASCII rig. It polled, got a status reply, and returned.
  //
  //   readMode was "MD;". newcat_get_mode sends "MD%c%c" — MD, a VFO digit, then
  //   the terminator — so the correct read is "MD0;" for the main VFO. A newcat
  //   rig answers a bare "MD;" with "?;", so mode polling never worked either.
  //
  // setMode was already right, and for a reason worth keeping: newcat wants
  // `MD0<c>;` and RADIO_FAMILIES stores the mode as two hex digits ("02", "0C"),
  // whose leading zero IS the main-VFO digit.
  "yaesu-ascii": {
    setFreq: { prefix: "FA", digits: 8 },
    readFreq: "FA;",
    setMode: { prefix: "MD" },
    readMode: "MD0;",
    pttOn: "TX1;",
    pttOff: "TX0;"
  },
  // Flex via SmartSDR CAT: Kenwood grammar with a ZZ prefix on the extended
  // commands. Not comparable to Hamlib, whose flexradio backend drives the
  // SmartSDR TCP API instead — see tools/hamlib-diff.mjs.
  "flex-ascii": {
    setFreq: { prefix: "ZZFA", digits: 11 },
    readFreq: "ZZFA;",
    setMode: { prefix: "ZZMD" },
    readMode: "ZZMD;",
    pttOn: "ZZTX1;",
    pttOff: "ZZTX0;"
  }
};

// The ASCII protocol used when a profile's protocol has no CAT_COMMANDS entry.
// Reached by "generic-ascii" and by any profile whose protocol is unknown; both
// are Kenwood-grammar assumptions, which is what the old `default:` branch did.
const DEFAULT_ASCII_PROTOCOL = "kenwood-ascii";

function commandsFor(protocol) {
  return CAT_COMMANDS[protocol] ?? CAT_COMMANDS[DEFAULT_ASCII_PROTOCOL];
}

// `{ prefix: "FA", digits: 11 }` + 14074000 -> "FA00014074000;"
export function asciiFreqCommand(spec, freqHz) {
  return `${spec.prefix}${String(Math.round(freqHz)).padStart(spec.digits, "0")};`;
}

// `{ prefix: "MD" }` + "0C" -> "MD0C;". The mode value is passed through
// unchanged: it is the raw protocol code, already in the form the radio expects.
export function asciiModeCommand(spec, modeValue) {
  return `${spec.prefix}${modeValue};`;
}

export const makeProfile = (familyId, id, name, overrides = {}) => ({
  ...RADIO_FAMILIES[familyId],
  id,
  name,
  ...overrides
});

// Rig catalogue. Everything except the entries below is GENERATED from Hamlib's
// own rig definitions — see tools/sync-hamlib.mjs and docs/hamlib-rig-import.md.
// To add or change a rig, edit tools/hamlib-map.json and re-run --build; do not
// hand-add entries here, or the next --check will fail.
//
// The four hand-written entries are the ones Hamlib cannot describe: "No Radio"
// (audio-only, not a rig at all) and the three rigctld daemon profiles, which
// reach a locally-run rigctld over a WebSocket bridge rather than Web Serial.
export const RADIO_PROFILES = {
  "0": { id: "0", name: "No Radio", protocol: "none", serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }, modes: [{ value: "USB", label: "USB" }, { value: "LSB", label: "LSB" }, { value: "CW", label: "CW" }, { value: "FM", label: "FM" }, { value: "AM", label: "AM" }] },
  "1": makeProfile("hamlib-rigctld", "1", "Hamlib Dummy (rigctld)"),
  "2": makeProfile("hamlib-rigctld", "2", "Hamlib NET rigctl"),
  "4": makeProfile("hamlib-rigctld", "4", "FLRig (via rigctld -m 4)"),

  // Hamlib-derived (tools/sync-hamlib.mjs --build). Ids are Hamlib model numbers;
  // "wh:"-prefixed ids are WebHam-only profiles Hamlib has no model for.
  ...Object.fromEntries(
    Object.entries(GENERATED_RIG_SPECS).map(([id, spec]) => [
      id,
      makeProfile(spec.family, id, spec.name, {
        ...(spec.serial ? { serial: spec.serial } : {}),
        // Per-rig Icom values from Hamlib's icom_priv_caps. Only Icoms carry them.
        ...(spec.civAddr !== undefined ? { civAddr: spec.civAddr } : {}),
        ...(spec.civ731 ? { civ731: true } : {}),
      }),
    ])
  ),
};

export function buildYaesu5ByteFrequencyCommand(frequencyHz) {
  const tenHertzUnits = Math.round(frequencyHz / 10);
  const digits = String(tenHertzUnits).padStart(8, "0");

  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
    Number.parseInt(digits.slice(6, 8), 16),
    CAT_COMMANDS["yaesu-5byte"].setFreq.opcode
  ];
}

// CI-V frequencies are little-endian packed BCD. Most Icoms take 10 digits in 5
// bytes; the ones Hamlib marks civ_731_mode take 8 digits in 4. Sending five bytes
// to a 731-mode rig makes the frame the wrong length, so the flag comes from the
// profile (imported from icom_priv_caps) rather than being assumed.
export function encodeCivFrequency(freqHz, mode731 = false) {
  const digits = mode731 ? 8 : 10;
  const bcd = [];
  const s = String(freqHz).padStart(digits, "0");
  for (let i = digits - 2; i >= 0; i -= 2) {
    bcd.push(Number.parseInt(s.slice(i, i + 2), 16));
  }
  return bcd;
}

export function decodeCivStatus(packet) {
  if (packet.length < 6) return {};

  const cmd = packet[4];
  const subcmd = packet[5];

  // Frequency Reply (FE FE <us> <radio> 03 <bcd> FD)
  if (cmd === 0x03) {
    const bcd = packet.slice(5, -1);
    const hz = decodeCivFrequency(bcd);
    return {
      frequency: hz ? formatFrequency(hz) : "",
      summary: `Icom frequency: ${hz ? formatFrequency(hz) : "Unknown"}`
    };
  }

  // Mode Reply (FE FE <us> <radio> 04 <mode> <filter> FD)
  if (cmd === 0x04) {
    const modeCode = packet[5];
    const modeName = decodeCivMode(modeCode);
    return {
      mode: modeName,
      summary: `Icom mode: ${modeName}`
    };
  }

  return {
    summary: `Icom reply: Command ${cmd.toString(16).toUpperCase()}`
  };
}

export function decodeCivFrequency(bcd) {
  let s = "";
  for (let i = bcd.length - 1; i >= 0; i--) {
    s += bcd[i].toString(16).padStart(2, "0");
  }
  return Number.parseInt(s, 10);
}

export function decodeCivMode(code) {
  const map = {
    0x00: "LSB", 0x01: "USB", 0x02: "AM", 0x03: "CW",
    0x04: "RTTY", 0x05: "FM", 0x06: "WFM", 0x07: "CW-R",
    0x08: "RTTY-R", 0x17: "DV"
  };
  return map[code] || `Mode 0x${code.toString(16).toUpperCase()}`;
}

export function decodeFt897Status(packet) {
  const frequencyHz = decodeBcdFrequency(packet.slice(0, 4));
  const modeCode = packet[4];
  const mode = ft897ModeName(modeCode);

  return {
    frequency: frequencyHz ? formatFrequency(frequencyHz) : "",
    mode,
    summary: `FT-897 status: ${frequencyHz ? formatFrequency(frequencyHz) : "Unknown frequency"}, ${mode}`
  };
}

export function decodeBcdFrequency(bytes) {
  const digits = bytes
    .map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
    .join("");

  const tenHertzUnits = Number.parseInt(digits, 10);
  if (Number.isNaN(tenHertzUnits)) {
    return 0;
  }

  return tenHertzUnits * 10;
}

export function ft897ModeName(modeCode) {
  const modeMap = {
    0x00: "LSB",
    0x01: "USB",
    0x02: "CW",
    0x03: "CWR",
    0x04: "AM",
    0x06: "WFM",
    0x08: "FM",
    0x0a: "DIG",
    0x0c: "PKT",
    0x88: "FM-N"
  };

  return modeMap[modeCode] || `Unknown (0x${modeCode.toString(16).toUpperCase().padStart(2, "0")})`;
}

export function decodeKenwoodMode(code) {
  const map = {
    "1": "LSB",
    "2": "USB",
    "3": "CW",
    "4": "FM",
    "5": "AM",
    "6": "DIG/FSK",
    "7": "CW-R",
    // No "8". Hamlib's kenwood_mode_table reads
    //   [8] = RIG_MODE_NONE,  /* TUNE mode or PKTUSB for SDRUNO */
    // and patches digit 8 to PKTUSB only for RIG_MODEL_SDRUNO, an SDR that is not
    // a Kenwood and is not in this catalogue. On real Kenwood hardware digit 8 is
    // TUNE, not a packet mode, so reporting it as "PKT" named a mode the radio was
    // not in. Returning "" makes decodeAsciiStatus show the raw code instead,
    // which is at least true.
    "9": "FSK-R"
  };

  return map[code] || "";
}

// Yaesu newcat MD characters. Separate from decodeKenwoodMode because the two
// protocols agree only up to digit 7 and then diverge: newcat puts PKTLSB on '8'
// where Kenwood has TUNE, and has no digit above 9 at all — 'A'…'F' carry PKTFM,
// FMN, PKTUSB, AMN, C4FM and PKTFMN. Routing newcat replies through the Kenwood
// table decoded the shared modes by luck and everything above CW-R wrongly.
//
// Values from Hamlib's rigs/yaesu/newcat.c newcat_mode_conv[]; checked against it
// by tools/hamlib-diff.mjs.
export function decodeNewcatMode(code) {
  const map = {
    "1": "LSB",
    "2": "USB",
    "3": "CW",
    "4": "FM",
    "5": "AM",
    "6": "RTTY",
    "7": "CW-R",
    "8": "DATA-L",
    "9": "RTTY-R",
    "A": "PKT-FM",
    "B": "FM-N",
    "C": "DATA-U",
    "D": "AM-N"
  };

  return map[String(code).toUpperCase()] || "";
}

export function decodeSmartSdrMode(code) {
  const map = {
    "0": "LSB",
    "1": "USB",
    "2": "DSB",
    "3": "CW",
    "4": "FM",
    "5": "AM",
    "6": "DIGU",
    "7": "SPEC",
    "8": "DIGL",
    "9": "SAM",
    "A": "NFM"
  };

  return map[code] || "";
}

// ============================================================================
// ============================================================================
// Hamlib rigctld line protocol (pure helpers, exported for unit testing)
// ============================================================================
// rigctld speaks newline-terminated commands over its TCP socket; the bridge
// relays them verbatim over a WebSocket. Set commands reply `RPRT <code>`
// (0 = success). `f` (get freq) replies one line: the frequency in Hz. `m`
// (get mode) replies TWO lines: the mode token then the passband in Hz.

export function rigctlSetFreqCommand(freqHz) {
  return `F ${Math.round(freqHz)}`;
}
export function rigctlSetModeCommand(modeToken, passbandHz = 0) {
  return `M ${modeToken} ${passbandHz}`;
}
export function rigctlSetPttCommand(on) {
  return `T ${on ? 1 : 0}`;
}

// A reply router. rigctld answers commands in order, and different commands
// consume a different number of reply lines, so parsing has to know what was
// asked — a bare digit line is a frequency after `f` but a passband after `m`.
// `expect(kind)` is called when a command is sent; `feed(text)` takes raw
// WebSocket text (possibly split mid-line, possibly several lines at once),
// buffers partial lines, and returns the events it could complete.
export function createRigctlParser() {
  const pending = []; // { kind: "freq"|"mode"|"rprt", need, lines: [] }
  let buffer = "";
  const NEED = { freq: 1, mode: 2, rprt: 1 };

  function complete(desc) {
    if (desc.kind === "freq") {
      const hz = Number.parseInt(desc.lines[0], 10);
      return Number.isFinite(hz) && hz > 0 ? { type: "frequency", hz } : null;
    }
    if (desc.kind === "mode") {
      return { type: "mode", token: desc.lines[0], passbandHz: Number.parseInt(desc.lines[1], 10) || 0 };
    }
    // rprt
    const m = /^RPRT\s+(-?\d+)/.exec(desc.lines[0]);
    return { type: "rprt", code: m ? Number.parseInt(m[1], 10) : NaN };
  }

  return {
    expect(kind) { pending.push({ kind, need: NEED[kind], lines: [] }); },
    pendingCount() { return pending.length; },
    feed(text) {
      buffer += text;
      const events = [];
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (pending.length === 0) {
          // Unsolicited line: only trust a bare frequency; ignore anything else
          // rather than misattribute it.
          if (/^\d{3,}$/.test(line.trim())) events.push({ type: "frequency", hz: Number.parseInt(line, 10) });
          continue;
        }
        const head = pending[0];
        head.lines.push(line.trim());
        if (head.lines.length >= head.need) {
          pending.shift();
          const ev = complete(head);
          if (ev) events.push(ev);
        }
      }
      return events;
    },
  };
}

// Web Serial session
// ============================================================================

const RADIO_POLL_INTERVAL_MS = 5000;

// Live Web Serial handles. Never exposed on `cat` directly — the old monolith only
// ever needed truthy/falsy "are we connected" checks on state.port/
// state.writer, which are now served by isConnected() (those were the monolith's
// Object.defineProperty(state, "port"/"writer", ...) shims; deleted along
//
// js/apps/ft8/index.js's header note).
let port = null;
let reader = null;
let writer = null;
let readBuffer = [];

// Hamlib rigctld WebSocket transport (parallel to the serial port above). Only
// one transport is live at a time — the active profile's `transport` decides.
let ws = null;
let rigctlParser = null;

const DEFAULT_BRIDGE_URL = "ws://localhost:8073";
function readBridgeUrl() {
  if (typeof localStorage === "undefined") return DEFAULT_BRIDGE_URL;
  try {
    return localStorage.getItem(KEYS.CAT_SETTINGS_KEY + ".bridgeUrl") || DEFAULT_BRIDGE_URL;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

// True when the active profile talks rigctld over the WebSocket bridge rather
// than a serial codec.
function isWebSocketTransport() {
  return getProfile()?.transport === "websocket";
}

let lastFrequency = "";
let lastMode = "";
let stagedFrequencyHz = 0;
let stagedModeValue = "";
let pttOn = false;

// Guarded like loadOverridesFor() below: this module is also imported by
// test-cat-codecs.mjs under plain Node, where `localStorage` doesn't exist.
// One-time renumbering, from when the catalogue adopted Hamlib's model numbers.
//
// RIG_ID_MIGRATION MUST be applied exactly once, and cannot be applied on read.
// It is a remapping, not a fixed point: "1008" -> "1009" (FT-767GX takes
// Hamlib's number) sits alongside "1009" -> "1011" (FT-840 takes its own), and
// "1015" -> "1024" alongside "1024" -> "wh:yaesu-ft-817nd". Feeding the table
// its own output walks an operator down that chain onto a different radio —
// FT-767GX to FT-840, or FT-1000MP to FT-817ND, which is not even the same
// protocol family. Migrating on read would do exactly that, because
// persistCatSettings writes the active (already-migrated) id back to the same
// key, so the next boot would migrate it a second time.
//
// Hence: rewrite storage once, guarded by a schema marker.
const RIG_ID_SCHEMA_KEY = KEYS.CAT_SETTINGS_KEY + ".rigIdSchema";
const RIG_ID_SCHEMA = "hamlib-1";

export function migrateProfileId(id) {
  return RIG_ID_MIGRATION[id] ?? id;
}

// Exported for test-rig-migration.mjs, which runs it twice over a stub store to
// prove the marker makes it exactly-once rather than merely usually-once.
export function migrateStoredRigIds(store = typeof localStorage === "undefined" ? null : localStorage) {
  if (!store) return false;
  try {
    if (store.getItem(RIG_ID_SCHEMA_KEY) === RIG_ID_SCHEMA) return false;

    const profileKey = `${KEYS.CAT_SETTINGS_KEY}.profile`;
    const stored = store.getItem(profileKey);
    if (stored && RIG_ID_MIGRATION[stored]) store.setItem(profileKey, RIG_ID_MIGRATION[stored]);

    // The overrides blob carries its own copy of the id it belongs to; leaving
    // it stale would silently drop the operator's confirmed serial settings back
    // to the profile defaults, since loadOverridesFor matches on that field.
    const overridesKey = `${KEYS.CAT_SETTINGS_KEY}.overrides`;
    const raw = store.getItem(overridesKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && RIG_ID_MIGRATION[saved.profileId]) {
        saved.profileId = RIG_ID_MIGRATION[saved.profileId];
        store.setItem(overridesKey, JSON.stringify(saved));
      }
    }

    store.setItem(RIG_ID_SCHEMA_KEY, RIG_ID_SCHEMA);
    return true;
  } catch {
    // Storage unavailable or corrupt: leave ids untouched rather than risk a
    // partial rewrite. The catalogue still loads; the profile falls back below.
    return false;
  }
}

migrateStoredRigIds();

function readStoredProfileId() {
  if (typeof localStorage === "undefined") {
    return "1023";
  }
  try {
    return localStorage.getItem(KEYS.CAT_SETTINGS_KEY + ".profile") || "1023";
  } catch {
    return "1023";
  }
}

let activeProfileId = readStoredProfileId();

// Settings-panel overrides (baudRate/dataBits/stopBits/parity/flowControl/
// civAddress), mirroring what used to live only in the DOM. null when no
// saved override matches the active profile (profile defaults apply).
let catOverrides = loadOverridesFor(activeProfileId);

let radioPollTimerId = null;
let radioPollInFlight = false;

// Optional guard installed via setPollGuard() — originally by the old monolith, now by
// js/apps/ft8/index.js's mount(): the original pollRadioFrequency()
// suspended polling during FT8 TX/tune (ft8State.ft8TxInProgress /
// ft8State.ft8TuneInProgress), which is FT8-app-only state this connector
// can't read directly.
let pollGuard = null;

function log(message) {
  cat.dispatchEvent(new CustomEvent("serial-log", { detail: message }));
}

function loadOverridesFor(profileId) {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS.CAT_SETTINGS_KEY + ".overrides"));
    // No renumbering here: migrateStoredRigIds() already rewrote this blob's
    // profileId in place at module load. Re-mapping on read would apply the
    // table a second time and stop matching.
    if (!saved || saved.profileId !== profileId) {
      return null;
    }
    return saved;
  } catch (e) {
    console.warn("Failed to apply CAT overrides", e);
    return null;
  }
}

function getSerialOptions() {
  const profile = getProfile();
  const o = catOverrides;
  return {
    baudRate: Number(o?.baudRate) || profile.serial.baudRate,
    dataBits: Number(o?.dataBits) || profile.serial.dataBits,
    stopBits: Number(o?.stopBits) || profile.serial.stopBits,
    parity: o?.parity || profile.serial.parity,
    flowControl: o?.flowControl || profile.serial.flowControl,
  };
}

export function buildCivPacket(cmd, subcmd = null, data = []) {
  const profile = getProfile();
  const { preamble, terminator, controller, defaultRadio } = CAT_COMMANDS["icom-civ"].frame;
  const toAddr = Number.parseInt(catOverrides?.civAddress || "0", 16) || profile.civAddr || defaultRadio;
  const fromAddr = controller;

  const packet = [preamble, preamble, toAddr, fromAddr, cmd];
  if (subcmd !== null) {
    packet.push(subcmd);
  }
  if (data && data.length) {
    packet.push(...data);
  }
  packet.push(terminator);
  return packet;
}

function decodeAsciiStatus(line) {
  if (line.startsWith("ZZFA")) {
    const digits = line.replace(/[^\d]/g, "");
    const frequencyHz = Number.parseInt(digits, 10);
    return {
      frequency: Number.isNaN(frequencyHz) ? "" : formatFrequency(frequencyHz),
      summary: `${getProfile().name} status: ${Number.isNaN(frequencyHz) ? line : formatFrequency(frequencyHz)}`
    };
  }

  if (line.startsWith("ZZMD")) {
    const code = line.replace(/^ZZMD/i, "").replace(/[^0-9A-Z]/gi, "");
    return {
      mode: decodeSmartSdrMode(code) || decodeKenwoodMode(code) || code,
      summary: `${getProfile().name} mode: ${decodeSmartSdrMode(code) || decodeKenwoodMode(code) || code}`
    };
  }

  if (line.startsWith("FA")) {
    const digits = line.replace(/[^\d]/g, "");
    const frequencyHz = Number.parseInt(digits, 10);
    return {
      frequency: Number.isNaN(frequencyHz) ? "" : formatFrequency(frequencyHz),
      summary: `${getProfile().name} status: ${Number.isNaN(frequencyHz) ? line : formatFrequency(frequencyHz)}`
    };
  }

  if (line.startsWith("MD")) {
    const digits = line.replace(/^MD/i, "").replace(/[^0-9A-Z]/gi, "");
    // A newcat reply carries the VFO digit the request asked for: `MD0;` is
    // answered `MD0<c>;`, so the mode character is the SECOND one. Kenwood replies
    // `MD<n>;` with no VFO digit. Stripping the wrong character decoded the VFO as
    // the mode — reporting every newcat rig as being in LSB, since the main VFO is
    // always '0' and there is no mode '0'.
    const isNewcat = getProfile().protocol === "yaesu-ascii";
    const code = isNewcat && digits.length > 1 ? digits.slice(1) : digits;
    const name = (isNewcat ? decodeNewcatMode(code) : decodeKenwoodMode(code)) || code;
    return {
      mode: name,
      summary: `${getProfile().name} mode: ${name}`
    };
  }

  return {
    summary: `${getProfile().name} reply: ${line}`
  };
}

export function getSelectedModeLabel() {
  const match = getModes().find((m) => m.value === stagedModeValue);
  return match ? match.label : stagedModeValue;
}

function formatSerialError(error) {
  if (!error) {
    return "Connect failed.";
  }

  if (error.name === "NotFoundError") {
    return "No serial port was selected. If the chooser was empty, close any other app using that COM port and make sure the device exposes a serial interface.";
  }

  if (error.name === "InvalidStateError") {
    return "That serial port is already open or busy. Close anything else using it, then try again.";
  }

  if (error.name === "NetworkError") {
    return "The browser could not open the serial port. Check the COM port, cable, and serial settings.";
  }

  if (error.name === "SecurityError") {
    return "Web Serial permission was blocked. Allow serial access when the browser asks — the grant is per site, so if you dismissed it once, clear it in the browser's site settings and try again.";
  }

  return `Connect failed: ${error.message}`;
}

async function connect() {
  if (isWebSocketTransport()) {
    await connectRigctld();
    return;
  }

  if (!("serial" in navigator)) {
    log("Web Serial is not supported in this browser. Radio control needs a desktop Chrome, Edge, or Firefox 151 or later.");
    return;
  }

  try {
    const selectedPort = await navigator.serial.requestPort();
    await openSelectedPort(selectedPort);
  } catch (error) {
    log(formatSerialError(error));
  }
}

// Open the rigctld WebSocket bridge. There is no browser permission prompt (as
// with requestPort), so "connect" and "reconnect" are the same action here;
// the radio app wires both buttons to connect() for this transport.
async function connectRigctld() {
  await disconnect({ silent: true });
  const url = readBridgeUrl();
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    log(`Bridge URL is not a valid WebSocket address: ${url} (${error.message})`);
    return;
  }

  rigctlParser = createRigctlParser();

  socket.addEventListener("open", () => {
    ws = socket;
    log(`${getProfile().name} connected via rigctld bridge ${url}.`);
    cat.dispatchEvent(new CustomEvent("status", { detail: "connected" }));
    void (async () => {
      await poll();
      startPolling();
    })();
  });

  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    if (text) handleRigctldText(text);
  });

  socket.addEventListener("error", () => {
    // The browser fires a bare Event with no detail on WS failure; the most
    // common cause here is no bridge listening at the URL.
    log(`rigctld bridge connection failed. Is a WebSocket bridge running at ${url}? (e.g. websockify 8073 localhost:4532)`);
  });

  socket.addEventListener("close", () => {
    if (ws === socket) {
      ws = null;
      rigctlParser = null;
      stopPolling();
      cat.dispatchEvent(new CustomEvent("disconnect", { detail: { silent: false } }));
      log("rigctld bridge disconnected.");
      cat.dispatchEvent(new CustomEvent("status", { detail: "disconnected" }));
    }
  });
}

function handleRigctldText(text) {
  if (!rigctlParser) return;
  log(`< ${text.trimEnd()}`);
  for (const ev of rigctlParser.feed(text)) {
    if (ev.type === "frequency") {
      lastFrequency = formatFrequency(ev.hz);
      log(`${getProfile().name} status: ${lastFrequency}`);
    } else if (ev.type === "mode") {
      const match = getModes().find((m) => m.value === ev.token);
      lastMode = match ? match.label : ev.token;
      log(`${getProfile().name} mode: ${lastMode}`);
    } else if (ev.type === "rprt" && ev.code !== 0 && !Number.isNaN(ev.code)) {
      log(`rigctld error: RPRT ${ev.code}`);
    }
    cat.dispatchEvent(new CustomEvent("status", { detail: "data" }));
  }
}

async function reconnect() {
  if (isWebSocketTransport()) {
    await connectRigctld();
    return;
  }

  if (!("serial" in navigator)) {
    log("Web Serial is not supported in this browser. Radio control needs a desktop Chrome, Edge, or Firefox 151 or later.");
    return;
  }

  try {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) {
      log("No previously authorized serial ports were found. Click Connect Radio first.");
      return;
    }

    await openSelectedPort(ports[0]);
  } catch (error) {
    log(formatSerialError(error));
  }
}

async function openSelectedPort(selectedPort) {
  await disconnect({ silent: true });
  port = selectedPort;
  await port.open(getSerialOptions());

  try {
    const dtr = getProfile().dtrAssert === true;
    await port.setSignals({ dataTerminalReady: dtr, requestToSend: false });
  } catch (e) {
    console.warn("Failed to set initial serial signals:", e);
  }

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  log(`${getProfile().name} connected.`);
  cat.dispatchEvent(new CustomEvent("status", { detail: "connected" }));
  readLoop();
  await wait(100);
  await poll();
  startPolling();
}

async function disconnect(options = {}) {
  const { silent = false } = options;

  // rigctld WebSocket transport. Null the module handle before closing so the
  // socket's own "close" listener (guarded on `ws === socket`) doesn't also
  // fire the disconnect/status events this function already emits below.
  if (ws) {
    const socket = ws;
    ws = null;
    rigctlParser = null;
    try { socket.close(); } catch {}
  }

  try {
    if (reader) {
      await reader.cancel();
      reader.releaseLock();
    }
  } catch {}

  try {
    if (writer) {
      writer.releaseLock();
    }
  } catch {}

  try {
    if (port) {
      try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      } catch {}
      await port.close();
    }
  } catch {}

  port = null;
  reader = null;
  writer = null;
  readBuffer = [];
  pttOn = false;
  stopPolling();
  radioPollInFlight = false;

  // The original disconnectRadio() also cleaned up monolith-only voice-keyer
  // state (voiceTxInProgress/voiceMediaRecorder/voiceRecorderStream/
  // speechSynthesis/voiceStatus) at exactly this point — after the port is
  // torn down but before the final log line and UI refresh. Connectors can't
  // reach into another module's state, so that cleanup is now
  // js/apps/audio-macros/index.js's job, run synchronously via
  // this "disconnect" listener before "status" fires updateRadioUi() (which
  // reads the voiceStatus this cleanup sets).
  cat.dispatchEvent(new CustomEvent("disconnect", { detail: { silent } }));

  if (!silent) {
    log("Radio disconnected.");
  }
  cat.dispatchEvent(new CustomEvent("status", { detail: "disconnected" }));
}

async function readLoop() {
  while (port && reader) {
    try {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.length === 0) {
        continue;
      }

      handleIncomingData(value);
    } catch (error) {
      log(`Read stopped: ${error.message}`);
      break;
    }
  }
}

function handleIncomingData(value) {
  const profile = getProfile();

  if (profile.protocol === "yaesu-5byte") {
    log(`< ${bytesToHex(value)}`);
    readBuffer.push(...value);
    parseFt897IncomingData();
    return;
  }

  if (profile.protocol === "icom-civ") {
    log(`< ${bytesToHex(value)}`);
    readBuffer.push(...value);
    parseCivIncomingData();
    return;
  }

  const text = new TextDecoder().decode(value);
  if (!text) {
    return;
  }

  log(`< ${text.trimEnd()}`);
  readBuffer.push(...Array.from(text));
  parseAsciiIncomingData();
}

function parseFt897IncomingData() {
  while (readBuffer.length >= 5) {
    const packet = readBuffer.splice(0, 5);
    const decoded = decodeFt897Status(packet);

    if (decoded.frequency) {
      lastFrequency = decoded.frequency;
    }

    if (decoded.mode) {
      lastMode = decoded.mode;
    }

    if (typeof decoded.pttOn === "boolean") {
      pttOn = decoded.pttOn;
    }

    if (decoded.summary) {
      log(decoded.summary);
    }

    cat.dispatchEvent(new CustomEvent("status", { detail: "data" }));
  }
}

function parseCivIncomingData() {
  while (readBuffer.length > 0) {
    const feIndex = readBuffer.indexOf(0xfe);
    if (feIndex === -1) {
      readBuffer = [];
      break;
    }

    if (feIndex > 0) {
      readBuffer.splice(0, feIndex);
    }

    if (readBuffer.length < 2 || readBuffer[1] !== 0xfe) {
      readBuffer.splice(0, 1);
      continue;
    }

    const fdIndex = readBuffer.indexOf(0xfd);
    if (fdIndex === -1) {
      break;
    }

    const packet = readBuffer.splice(0, fdIndex + 1);
    const decoded = decodeCivStatus(packet);

    if (decoded.frequency) {
      lastFrequency = decoded.frequency;
    }

    if (decoded.mode) {
      lastMode = decoded.mode;
    }

    if (decoded.summary) {
      log(decoded.summary);
    }

    cat.dispatchEvent(new CustomEvent("status", { detail: "data" }));
  }
}

function parseAsciiIncomingData() {
  const bufferText = readBuffer.join("");
  const parts = bufferText.split(/[;\r\n]+/);
  readBuffer = Array.from(parts.pop() || "");

  parts.forEach((part) => {
    const line = part.trim();
    if (!line) {
      return;
    }

    const decoded = decodeAsciiStatus(line);
    if (decoded.frequency) {
      lastFrequency = decoded.frequency;
    }

    if (decoded.mode) {
      lastMode = decoded.mode;
    }

    if (decoded.summary) {
      log(decoded.summary);
    }
  });

  cat.dispatchEvent(new CustomEvent("status", { detail: "data" }));
}

async function poll(options = {}) {
  const { frequencyOnly = false } = options;
  const profile = getProfile();
  const cmd = commandsFor(profile.protocol);

  switch (profile.protocol) {
    case "rigctld":
      await rigctldSend("f", "freq", "Read frequency (rigctld)");
      if (!frequencyOnly) {
        await rigctldSend("m", "mode", "Read mode (rigctld)");
      }
      break;
    case "yaesu-5byte":
      await sendCommand([0x00, 0x00, 0x00, 0x00, cmd.readAll.opcode], "Read status (FT-897)");
      break;
    case "icom-civ":
      await sendCommand(buildCivPacket(cmd.readFreq.cmd), "Read frequency (CI-V)");
      if (!frequencyOnly) {
        await sleep(120);
        await sendCommand(buildCivPacket(cmd.readMode.cmd), "Read mode (CI-V)");
      }
      break;
    case "kenwood-ascii":
    case "yaesu-ascii":
    case "flex-ascii":
    case "generic-ascii":
    default:
      await sendCommand(cmd.readFreq, "Read frequency (ASCII)");
      if (!frequencyOnly) {
        await wait(120);
        await sendCommand(cmd.readMode, "Read mode (ASCII)");
      }
      break;
  }
}

function startPolling() {
  stopPolling();
  if (!port && !ws) {
    return;
  }

  radioPollTimerId = window.setInterval(() => {
    void pollFrequencyTick();
  }, RADIO_POLL_INTERVAL_MS);
}

function stopPolling() {
  if (radioPollTimerId !== null) {
    clearInterval(radioPollTimerId);
    radioPollTimerId = null;
  }
}

async function pollFrequencyTick() {
  if ((!port && !ws) || radioPollInFlight) {
    return;
  }
  // Suppress CAT polling during FT8 TX/tune — some radios misinterpret
  // frequency-read commands received while PTT is asserted. (Was the monolith's
  // pollRadioFrequency() checking state.ft8TxInProgress/ft8TuneInProgress.)
  if (pollGuard && pollGuard()) {
    return;
  }

  radioPollInFlight = true;
  try {
    await poll({ frequencyOnly: true });
  } finally {
    radioPollInFlight = false;
  }
}

async function setFrequency(freqHz) {
  if (!Number.isFinite(freqHz) || freqHz <= 0) {
    log("Enter a valid frequency before sending.");
    return;
  }

  stagedFrequencyHz = freqHz;
  cat.dispatchEvent(new CustomEvent("frequency", { detail: freqHz }));

  if (!writer && !ws) return;

  const profile = getProfile();
  const cmd = commandsFor(profile.protocol);

  switch (profile.protocol) {
    case "rigctld":
      await rigctldSend(rigctlSetFreqCommand(freqHz), "rprt", `Set frequency: ${formatFrequency(freqHz)}`);
      break;
    case "yaesu-5byte": {
      const yPacket = buildYaesu5ByteFrequencyCommand(freqHz);
      await sendCommand(yPacket, `Set frequency: ${formatFrequency(freqHz)}`);
      break;
    }
    case "icom-civ": {
      const cPacket = buildCivPacket(cmd.setFreq.cmd, null, encodeCivFrequency(freqHz, profile.civ731 === true));
      await sendCommand(cPacket, `Set frequency: ${formatFrequency(freqHz)}`);
      break;
    }
    case "flex-ascii":
    case "kenwood-ascii":
    case "yaesu-ascii":
    case "generic-ascii":
    default:
      await sendCommand(asciiFreqCommand(cmd.setFreq, freqHz), `Set frequency: ${formatFrequency(freqHz)}`);
      break;
  }

  lastFrequency = formatFrequency(freqHz);
}

async function setMode(modeVal) {
  if (modeVal !== undefined) stagedModeValue = modeVal;
  const val = stagedModeValue;
  const profile = getProfile();
  const cmd = commandsFor(profile.protocol);

  switch (profile.protocol) {
    case "rigctld":
      await rigctldSend(rigctlSetModeCommand(val), "rprt", `Set mode: ${getSelectedModeLabel()}`);
      lastMode = getSelectedModeLabel();
      break;
    case "yaesu-5byte": {
      const yCode = Number.parseInt(val, 16);
      await sendCommand([yCode, 0x00, 0x00, 0x00, cmd.setMode.opcode], `Set mode: ${ft897ModeName(yCode)}`);
      lastMode = ft897ModeName(yCode);
      break;
    }
    case "icom-civ": {
      const cCode = Number.parseInt(val, 16);
      await sendCommand(buildCivPacket(cmd.setMode.cmd, cCode), `Set mode: ${getSelectedModeLabel()}`);
      lastMode = getSelectedModeLabel();
      break;
    }
    case "flex-ascii":
    case "kenwood-ascii":
    case "yaesu-ascii":
    case "generic-ascii":
    default:
      await sendCommand(asciiModeCommand(cmd.setMode, val), `Set mode: ${getSelectedModeLabel()}`);
      lastMode = getSelectedModeLabel();
      break;
  }

  cat.dispatchEvent(new CustomEvent("mode", { detail: lastMode }));
}

async function togglePtt() {
  await setPtt(!pttOn);
}

async function setPtt(nextPttState) {
  if (pttOn === nextPttState) {
    return;
  }

  const profile = getProfile();
  const cmd = commandsFor(profile.protocol);
  const label = nextPttState ? "PTT On" : "PTT Off";

  switch (profile.protocol) {
    case "rigctld":
      await rigctldSend(rigctlSetPttCommand(nextPttState), "rprt", label);
      break;
    case "yaesu-5byte":
      await sendCommand([0x00, 0x00, 0x00, 0x00, nextPttState ? cmd.pttOn.opcode : cmd.pttOff.opcode], label);
      break;
    case "icom-civ":
      await sendCommand(
        buildCivPacket(cmd.ptt.cmd, cmd.ptt.sub, [nextPttState ? cmd.ptt.on : cmd.ptt.off]),
        label
      );
      break;
    case "flex-ascii":
    case "kenwood-ascii":
    case "yaesu-ascii":
    case "generic-ascii":
    default:
      await sendCommand(nextPttState ? cmd.pttOn : cmd.pttOff, label);
      break;
  }

  pttOn = nextPttState;
  cat.dispatchEvent(new CustomEvent("ptt", { detail: pttOn }));
}

async function sendCommand(command, label) {
  if (!writer) {
    log("Connect a radio before sending CAT commands.");
    return;
  }

  try {
    const payload =
      typeof command === "string"
        ? new TextEncoder().encode(command)
        : Uint8Array.from(command);
    await writer.write(payload);
    log(`> ${label || "CAT command"} (${bytesToHex(payload)})`);
  } catch (error) {
    log(`Write failed: ${error.message}`);
  }
}

// Send one rigctld command line over the WebSocket bridge and register what
// kind of reply it should produce, so handleRigctldText can attribute the
// answer correctly (see createRigctlParser).
async function rigctldSend(command, expectKind, label) {
  if (!ws) {
    log("Connect the rigctld bridge before sending CAT commands.");
    return;
  }
  try {
    if (rigctlParser && expectKind) rigctlParser.expect(expectKind);
    ws.send(command + "\n");
    log(`> ${label || "rigctld command"} (${command})`);
  } catch (error) {
    log(`Bridge send failed: ${error.message}`);
  }
}

function findProfileModeValue(modeName) {
  const normalizedMode = String(modeName || "").toUpperCase();
  if (!normalizedMode) {
    return "";
  }

  const profile = getProfile();
  const directMatch = profile.modes.find((mode) => mode.label.toUpperCase() === normalizedMode);
  if (directMatch) {
    return directMatch.value;
  }

  if (normalizedMode === "FT8" || normalizedMode === "FT4") {
    const digitalMatch = profile.modes.find((mode) => /DIG|PKT|FSK|FT8/i.test(mode.label));
    return digitalMatch ? digitalMatch.value : "";
  }

  if (normalizedMode === "SSB") {
    const ssbMatch = profile.modes.find((mode) => /USB|LSB/.test(mode.label.toUpperCase()));
    return ssbMatch ? ssbMatch.value : "";
  }

  const partialMatch = profile.modes.find((mode) => normalizedMode.includes(mode.label.toUpperCase()) || mode.label.toUpperCase().includes(normalizedMode));
  return partialMatch ? partialMatch.value : "";
}

function stageTune(frequencyHz, modeName) {
  if (frequencyHz) {
    stagedFrequencyHz = frequencyHz;
    cat.dispatchEvent(new CustomEvent("frequency", { detail: frequencyHz }));
  }

  const modeValue = findProfileModeValue(modeName);
  if (modeValue) {
    stagedModeValue = modeValue;
    cat.dispatchEvent(new CustomEvent("mode", { detail: modeValue }));
  }
}

function getProfile() {
  return RADIO_PROFILES[activeProfileId];
}

function getProfileId() {
  return activeProfileId;
}

function setProfile(id) {
  activeProfileId = id;
  readBuffer = [];
  lastFrequency = "";
  lastMode = "";
  stagedFrequencyHz = 0;
  stagedModeValue = "";
  // A profile switch invalidates any override loaded for the previous
  // profile; js/apps/radio/index.js's applyCatOverrides() (-> applyOverrides()
  // below) will repopulate this if the new profile has a saved override on
  // file —
  // mirroring how the DOM used to fall back to profile defaults until a
  // matching saved override was restored on top.
  catOverrides = null;
}

function isConnected() {
  return Boolean(port || ws);
}

function getFrequency() {
  return lastFrequency;
}

function getMode() {
  return lastMode;
}

function getStagedFrequency() {
  return stagedFrequencyHz;
}

function setStagedFrequency(hz) {
  stagedFrequencyHz = hz;
}

function setStagedFrequencyAndNotify(hz) {
  // stage + emit "frequency" so shared UI reflects a split-tune the radio was just commanded to
  stagedFrequencyHz = hz;
  cat.dispatchEvent(new CustomEvent("frequency", { detail: hz }));
}

function getStagedMode() {
  return stagedModeValue;
}

function setStagedMode(value) {
  stagedModeValue = value;
}

function getPtt() {
  return pttOn;
}

function getModes() {
  return getProfile()?.modes || [];
}

function persistSettings(overrides) {
  catOverrides = overrides;
  localStorage.setItem(KEYS.CAT_SETTINGS_KEY + ".profile", overrides.profileId);
  localStorage.setItem(KEYS.CAT_SETTINGS_KEY + ".overrides", JSON.stringify(overrides));
}

function applyOverrides(profileId) {
  const saved = loadOverridesFor(profileId);
  if (saved) {
    catOverrides = saved;
  }
  return saved;
}

function setPollGuard(fn) {
  pollGuard = fn;
}

// The rigctld WebSocket bridge URL is CAT config, so it lives beside the other
// CAT settings in localStorage and the connector owns the key (the radio app's
// settings UI reads/writes through these rather than touching storage).
function getBridgeUrl() {
  return readBridgeUrl();
}

function setBridgeUrl(url) {
  if (typeof localStorage === "undefined") return;
  const clean = (url || "").trim();
  if (clean) localStorage.setItem(KEYS.CAT_SETTINGS_KEY + ".bridgeUrl", clean);
  else localStorage.removeItem(KEYS.CAT_SETTINGS_KEY + ".bridgeUrl");
}

// whether the logger's Frequency field chases the live rig
// frequency. Was the monolith `state.freqFollowRadio` (a plain boolean),
// but it's read/written by js/apps/radio/index.js (bindFreqQuickset,
// syncLoggerFreqFollow) AND written by js/apps/logger/index.js's own
// startFormEdit (; sets it false when editing a past
// QSO so the field stops following the rig) — two independent modules
// needing read+write on the same flag, so it moved to the one surface both
// can already reach, same "shared + pure -> connector" reasoning
// js/connectors/spots.js's potaFilter note documents.
let freqFollowRadio = true;

function getFreqFollow() {
  return freqFollowRadio;
}

function setFreqFollow(value) {
  freqFollowRadio = value;
}

// the mode-quickset mirror of freqFollowRadio
// above — whether the logger's Mode field chases the rig's live mode. Same
// two-module read+write shape (js/apps/radio/index.js's bindModeQuickset/
// syncLoggerModeFollow, js/apps/logger/index.js's startFormEdit), so it
// lives here for the same reason.
let modeFollowRadio = true;

function getModeFollow() {
  return modeFollowRadio;
}

function setModeFollow(value) {
  modeFollowRadio = value;
}

Object.assign(cat, {
  connect, reconnect, disconnect,
  setFrequency, setMode, setPtt, togglePtt, sendCommand,
  poll, startPolling, stopPolling,
  getProfile, setProfile, getProfileId,
  isConnected, stageTune,
  // Beyond the brief's primary method list: several UI functions — originally
  // all in the old monolith, now split across js/apps/radio/index.js,
  // js/apps/ft8/index.js, and js/apps/satellites/index.js — read/write
  // staged/live radio values directly without going through connect/
  // setFrequency/setMode (handleModeQuickSelect, adjustFrequencyByStep,
  // applyFt8Defaults, satellite doppler auto-tune, updateRadioUi/
  // syncRadioConsole/updateMissionDashboard/getSelectedModeLabel). These
  // getters/setters replace direct state.* field access — see
  //
  getFrequency, getMode,
  getStagedFrequency, setStagedFrequency, setStagedFrequencyAndNotify,
  getStagedMode, setStagedMode,
  getPtt, getModes,
  persistSettings, applyOverrides,
  setPollGuard,
  getFreqFollow, setFreqFollow,
  getModeFollow, setModeFollow,
  getBridgeUrl, setBridgeUrl,
});
