// Self-check for js/psk.js PSKReporter MQTT helpers. Run: node test-psk.mjs
import assert from "node:assert";
import { pskTopicForCall, parsePskSpot } from "../js/psk.js";

// PSK topic: who-heard-me filters on tx_call (sender = me), uppercased
assert.equal(pskTopicForCall("k1abc"), "pskr/filter/v2/+/+/K1ABC/#");

// PSK parse: plot the RECEIVER (rc/rl), band from b
const spot = parsePskSpot({ sc:"K1ABC", sl:"FN31", rc:"G3XYZ", rl:"IO91", f:14074000, md:"FT8", rp:-12, b:"20m", ra:223, t_tx:1700000000 });
assert.equal(spot.call, "G3XYZ");
assert.equal(spot.grid, "IO91");
assert.equal(spot.band, "20m");
assert.equal(spot.snr, -12);
assert.equal(spot.freqHz, 14074000);
assert.equal(parsePskSpot({ sc:"K1ABC", rc:"G3XYZ" }), null, "no rx grid -> null");

console.log("psk.js: all assertions passed");
