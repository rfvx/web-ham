// Self-check for pure CAT codecs. Run: node test-cat-codecs.mjs
//
// buildCivPacket moved into this connector as part of Task 9 (Web Serial
// session). It now reads the connector's own activeProfileId/catOverrides
// instead of app.js's getActiveProfile()/els.civAddress.value. Under plain
// Node (no localStorage), catOverrides stays null and activeProfileId falls
// back to "1023" (Yaesu FT-897 — a yaesu-5byte profile with no civAddr), so
// the CI-V address framing below falls through to the fallback address, same as
// a fresh browser session with no CAT settings saved yet and a non-Icom
// profile active. decodeAsciiStatus stays internal to cat.js (untestable in
// isolation — it only formats getProfile().name into summary strings).
import assert from "node:assert";
import {
  buildYaesu5ByteFrequencyCommand, encodeCivFrequency, decodeCivFrequency,
  decodeBcdFrequency, buildCivPacket, RADIO_FAMILIES, RADIO_PROFILES,
  CAT_COMMANDS, decodeKenwoodMode, decodeNewcatMode,
} from "../js/connectors/cat.js";

// Yaesu FT-8x7 5-byte frequency command: 14.074 MHz -> 10Hz units 1407400,
// padded to 8 digits "01407400", split into 4 BCD-hex byte pairs + cmd 0x01.
assert.deepEqual(
  Array.from(buildYaesu5ByteFrequencyCommand(14074000)),
  [0x01, 0x40, 0x74, 0x00, 0x01],
);

// Regression coverage for js/apps/satellites/index.js's setRadioSplitFrequencies()
// ft897/yaesu-5byte branch (fixed: used to call an undefined
// buildFrequencyCommand(), throwing ReferenceError and leaving the radio
// half-tuned). SO-50's 436.795 MHz downlink (SATELLITE_RADIO_FREQUENCIES) ->
// 10Hz units 43679500, already 8 digits "43679500", split into BCD-hex byte
// pairs 0x43/0x67/0x95/0x00 + cmd 0x01.
assert.deepEqual(
  Array.from(buildYaesu5ByteFrequencyCommand(436795000)),
  [0x43, 0x67, 0x95, 0x00, 0x01],
);

// CI-V frequency encode/decode round trip. encodeCivFrequency pads to 10
// digits ("0014074000") and emits BCD-hex bytes least-significant-pair
// first: [0x00, 0x40, 0x07, 0x14, 0x00].
assert.deepEqual(encodeCivFrequency(14074000), [0x00, 0x40, 0x07, 0x14, 0x00]);
assert.equal(decodeCivFrequency(encodeCivFrequency(14074000)), 14074000);

// Rigs Hamlib marks civ_731_mode take 8 BCD digits in 4 bytes, not 10 in 5. The
// flag comes from the profile (imported from icom_priv_caps), so the frame length
// follows the radio instead of being assumed.
assert.deepEqual(encodeCivFrequency(14074000, true), [0x00, 0x40, 0x07, 0x14]);
assert.equal(decodeCivFrequency(encodeCivFrequency(14074000, true)), 14074000);
// The one such rig in the catalogue, so the flag cannot quietly stop being emitted.
assert.equal(RADIO_PROFILES["3064"].civ731, true, "Ten-Tec Delta II is a civ_731_mode rig");
assert.equal(RADIO_PROFILES["3300"]?.civ731, undefined);

// Per-rig CI-V addresses, imported from Hamlib's icom_priv_caps. Nothing set
// profile.civAddr before, so buildCivPacket's fallback addressed every Icom
// identically and the operator had to type the address in by hand.
assert.equal(RADIO_PROFILES["3073"].civAddr, 0x94, "IC-7300 CI-V address");
assert.equal(RADIO_PROFILES["3085"].civAddr, 0xA4, "IC-705 CI-V address");
assert.equal(RADIO_PROFILES["3081"].civAddr, 0xA2, "IC-9700 CI-V address");
// A non-Icom must not carry one.
assert.equal(RADIO_PROFILES["1023"].civAddr, undefined, "FT-897 has no CI-V address");

// Yaesu/FT-897 status BCD-hex bytes, most-significant byte first ->
// 10Hz-unit digits "01407400" -> Hz.
assert.equal(decodeBcdFrequency([0x01, 0x40, 0x74, 0x00]), 14074000);

// buildCivPacket default framing (Task 9): no saved civAddress override, and
// the default active profile isn't an Icom (civAddr undefined), so toAddr falls
// all the way back to CAT_COMMANDS' defaultRadio.
//
// That fallback used to be 0xE0, which icom_defs.h defines as CTRLID — the
// *controller's* address. A frame addressed to a controller is not addressed to
// any radio, so it went unanswered. It is now BCASTID (0x00), the CI-V broadcast
// address, which transceivers do answer. fromAddr is always 0xE1 ("us").
// No subcmd/data -> [FE FE <to> <from> <cmd> FD].
assert.deepEqual(buildCivPacket(0x03), [0xFE, 0xFE, 0x00, 0xE1, 0x03, 0xFD]);
// With a subcmd and data payload appended before the FD terminator.
assert.deepEqual(
  buildCivPacket(0x06, 0x01, [0xAA]),
  [0xFE, 0xFE, 0x00, 0xE1, 0x06, 0x01, 0xAA, 0xFD],
);
assert.notEqual(
  CAT_COMMANDS["icom-civ"].frame.defaultRadio, 0xE0,
  "0xE0 is CTRLID, a controller address — never a default to address a radio at",
);

// ── ASCII command strings ────────────────────────────────────────────────────
//
// Yaesu newcat is not Kenwood, and treating it as such broke PTT and mode
// polling on every yaesu-ascii rig. Pinned individually so a regression names
// the operation rather than just a byte. See tools/hamlib-diff.mjs.
const newcat = CAT_COMMANDS["yaesu-ascii"];
const kenwood = CAT_COMMANDS["kenwood-ascii"];
assert.equal(newcat.pttOn, "TX1;", "newcat transmits with TX1;, not TX;");
assert.equal(newcat.pttOff, "TX0;", "newcat receives with TX0;; RX; is not a newcat command");
assert.equal(newcat.readMode, "MD0;", "newcat read-mode carries a VFO digit");
// Kenwood really does use the bare forms, and must not be dragged along.
assert.equal(kenwood.pttOn, "TX;");
assert.equal(kenwood.pttOff, "RX;");
assert.equal(kenwood.readMode, "MD;");

// The two ASCII mode decoders agree up to CW-R and then diverge; routing newcat
// replies through the Kenwood table got everything above it wrong.
assert.equal(decodeNewcatMode("C"), "DATA-U", "newcat 'C' is PKTUSB");
assert.equal(decodeKenwoodMode("C"), "", "Kenwood has no mode 'C'");
assert.equal(decodeNewcatMode("8"), "DATA-L", "newcat '8' is PKTLSB");
// Hamlib's kenwood_mode_table has [8] = RIG_MODE_NONE ("TUNE mode or PKTUSB for
// SDRUNO"), so digit 8 is not a packet mode on Kenwood hardware.
assert.equal(decodeKenwoodMode("8"), "", "Kenwood digit 8 is TUNE, not PKT");
assert.equal(decodeNewcatMode("6"), "RTTY");
assert.equal(decodeKenwoodMode("6"), "DIG/FSK");

// ── Icom CI-V mode codes ─────────────────────────────────────────────────────
//
// Mode `value`s are raw CI-V mode codes: setMode's "icom-civ" branch does
// Number.parseInt(val, 16) and sends the result as the data byte of command
// 0x06. They are fixed by the CI-V spec and identical across the Icom line —
// Hamlib keeps one table for every Icom backend in rigs/icom/icom_defs.h.
//
// icom-civ-modern once had every code one high (LSB..FM as 01..06), so an
// IC-7300 asked for USB was sent 0x02 and went to AM, CW went to RTTY, FM went
// to Wide FM. Pinned here against the Hamlib constants so it cannot drift back.
const CIV_MODE_CODES = {
  LSB: 0x00,   // S_LSB
  USB: 0x01,   // S_USB
  AM: 0x02,    // S_AM
  CW: 0x03,    // S_CW
  RTTY: 0x04,  // S_RTTY
  FM: 0x05,    // S_FM
  DV: 0x17,    // S_DSTAR
};

for (const family of ["icom-civ-classic", "icom-civ-modern"]) {
  const modes = RADIO_FAMILIES[family].modes;
  assert.ok(modes.length > 0, `${family} has no modes`);
  for (const { value, label } of modes) {
    const expected = CIV_MODE_CODES[label];
    assert.notEqual(expected, undefined, `${family}: unexpected mode label "${label}"`);
    assert.equal(
      Number.parseInt(value, 16),
      expected,
      `${family} ${label}: sends 0x${Number.parseInt(value, 16).toString(16).padStart(2, "0")}, ` +
      `CI-V says 0x${expected.toString(16).padStart(2, "0")}`
    );
  }
}

// Both Icom families speak the same protocol; only the default baud differs.
assert.equal(RADIO_FAMILIES["icom-civ-classic"].protocol, "icom-civ");
assert.equal(RADIO_FAMILIES["icom-civ-modern"].protocol, "icom-civ");
assert.notEqual(
  RADIO_FAMILIES["icom-civ-classic"].serial.baudRate,
  RADIO_FAMILIES["icom-civ-modern"].serial.baudRate,
);

console.log("test-cat-codecs: all assertions passed");
