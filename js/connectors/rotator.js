// Rotator connector — a second Web Serial port for the antenna rotator, speaking
// Easycomm. Mirrors the cat connector's shape: the live handles stay
// module-local and every UI reaction is an event.
//
// Events: "status" (detail: "connected" | "disconnected"), "serial-log".
//
// WebHam only writes to the rotator today. The incoming stream is drained and
// discarded rather than left unread — see drainIncoming().
export const rotator = new EventTarget();

let port = null;
let writer = null;
let reader = null;

function log(message) {
  rotator.dispatchEvent(new CustomEvent("serial-log", { detail: message }));
}

async function connect() {
  if (!("serial" in navigator)) {
    log("Web Serial is not supported in this browser. Rotator control needs a desktop Chrome, Edge, or Firefox 151 or later.");
    return;
  }
  try {
    const selectedPort = await navigator.serial.requestPort();
    await selectedPort.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: "none" });
    port = selectedPort;
    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    void drainIncoming(reader);

    log("Rotator connected (WebSerial). Tracking enabled via Easycomm protocol.");
    rotator.dispatchEvent(new CustomEvent("status", { detail: "connected" }));
  } catch (error) {
    log(`Rotator connect error: ${error.message}`);
  }
}

// WebHam only WRITES to the rotator — nothing consumes Easycomm's position
// replies yet. But connect() takes a reader, which locks port.readable, and a
// locked stream that is never read applies backpressure: an Easycomm controller
// that reports position (many do, continuously, once tracking starts) fills the
// queue and then stalls, with nothing anywhere to say so.
//
// So drain and discard. When a position readout is wanted later, this is the
// loop to parse in — and until then the port stays healthy.
async function drainIncoming(activeReader) {
  try {
    while (true) {
      const { done } = await activeReader.read();
      if (done) break;
    }
  } catch {
    // cancel() during disconnect lands here; nothing to report.
  }
}

async function disconnect() {
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
      await port.close();
    }
  } catch {}
  port = null;
  writer = null;
  reader = null;
  log("Rotator disconnected.");
  rotator.dispatchEvent(new CustomEvent("status", { detail: "disconnected" }));
}

async function send(cmdString) {
  if (!writer) return;
  try {
    const payload = new TextEncoder().encode(cmdString);
    await writer.write(payload);
  } catch (error) {
    log(`Rotator Write failed: ${error.message}`);
  }
}

Object.assign(rotator, { connect, disconnect, send });
