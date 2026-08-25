// PSKReporter MQTT helpers: build the subscription topic for a callsign, and
// normalize an incoming MQTT message into a reception spot. Pure and
// node-testable (see test-psk.mjs) — kept out of js/connectors/spots.js
// because that connector touches localStorage at module-eval time and can't
// be imported under plain node. Consumed by the spots connector.

export function pskTopicForCall(call) {
  const c = String(call || "").trim().toUpperCase();
  return `pskr/filter/v2/+/+/${c}/#`;
}

// Normalize a PSKReporter MQTT message to a spot for the RECEIVER (who heard me).
export function parsePskSpot(msg) {
  if (!msg || typeof msg !== "object") return null;
  const grid = String(msg.rl || "").trim().toUpperCase();
  if (!/^[A-R]{2}\d{2}/.test(grid)) return null;
  return {
    call: String(msg.rc || "").toUpperCase(),
    grid,
    snr: Number.isFinite(msg.rp) ? msg.rp : null,
    freqHz: Number.isFinite(msg.f) ? msg.f : null,
    band: String(msg.b || ""),
    mode: String(msg.md || ""),
    dxcc: Number.isFinite(msg.ra) ? msg.ra : null,
    epoch: Number.isFinite(msg.t_tx) ? msg.t_tx : null,
  };
}
