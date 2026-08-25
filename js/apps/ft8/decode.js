// FT8 mini-app — decode pipeline (WASM decode dispatch, symbol/frame-sync
// experimental decoder), auto-sequencing (WSJT-X-style QSO advance), and the
// FT8 protocol constants both depend on.
//
// Cross-file seams (circular import with ./index.js, safe — see that file's
// header note): this module reads/writes the shared `ft8State` object and
// calls index.js's own `appendSerialLog` (thin bus dispatcher), plus a
// handful of index.js-owned UI functions that auto-seq and the boundary
// decoder need to drive after a decode advances the QSO —
// `applyFt8DecodeToForm`/`selectFt8Message`/`setFt8TxEnabled` (TX
// orchestration) and `renderFt8TextDecodes` (decode-list UI). None of these
// are read at module-evaluation time (only inside functions called after
// mount()), so the circular reference resolves fine under ES module
// semantics.
import { ft8FindGridField } from "../../grid.js";
import { normalizeToken, percentile, escapeHtml } from "../../utils.js";
import { bus } from "../../bus.js";
import {
  ft8State, appendSerialLog, applyFt8DecodeToForm, selectFt8Message,
  setFt8TxEnabled, renderFt8TextDecodes, ft8Now,
} from "./index.js";

// WSJT-X-style Tx watchdog: auto-sequencing is halted this long after the last
// genuine QSO progress (or manual queue) to prevent runaway transmission.
export const FT8_AUTOSEQ_WATCHDOG_MS = 6 * 60 * 1000;

const FT8_COSTAS_SEQUENCE = [3, 1, 4, 0, 6, 5, 2];
const FT8_SYNC_BLOCK_STARTS = [0, 36, 72];
const FT8_GRAY_BITS = {
  0: "000",
  1: "001",
  2: "011",
  3: "010",
  4: "110",
  5: "100",
  6: "101",
  7: "111"
};

// NOTE: deliberate exception to the els-in-mount() pattern every other app
// follows. These resolve at module-eval (import) time, not inside mount().
// Safe only because the #tab-ft8 panel and its #ft8-* children ship in
// index.html's static markup and the shell's tab manager *moves* panels
// (appendChild) rather than recreating them — so the elements exist and keep
// their identity before ft8's mount() runs. If either fact changes, wrap this
// in an init() called from index.js's mount(). No decode.js code reads els at
// module top level, so that move would be mechanical.
const els = {
  ft8Activity: document.querySelector("#ft8-activity"),
  ft8NoiseFloor: document.querySelector("#ft8-noise-floor"),
  ft8PeakTone: document.querySelector("#ft8-peak-tone"),
  ft8DecoderList: document.querySelector("#ft8-decoder-list"),
  ft8ChannelBits: document.querySelector("#ft8-channel-bits"),
  ft8DecoderStatus: document.querySelector("#ft8-decoder-status"),
  ft8LastFrame: document.querySelector("#ft8-last-frame"),
  ft8PayloadBits: document.querySelector("#ft8-payload-bits"),
  ft8SlotLabel: document.querySelector("#ft8-slot-label"),
  ft8SymbolStream: document.querySelector("#ft8-symbol-stream"),
  ft8FrameBuffer: document.querySelector("#ft8-frame-buffer"),
  ft8SyncQuality: document.querySelector("#ft8-sync-quality"),
  ft8MyCall: document.querySelector("#ft8-my-call"),
  ft8DxCall: document.querySelector("#ft8-dx-call"),
};

export function updateExperimentalDecoder() {
  if (!ft8State.analyser || !ft8State.audioContext) {
    return;
  }

  const now = performance.now();
  if (now - ft8State.lastDecodeAt < 350) {
    return;
  }
  ft8State.lastDecodeAt = now;

  const lowHz = 200;
  const highHz = 3000;
  const fft = new Float32Array(ft8State.analyser.frequencyBinCount);
  ft8State.analyser.getFloatFrequencyData(fft);

  const hzPerBin = ft8State.audioContext.sampleRate / ft8State.analyser.fftSize;
  const startBin = Math.max(0, Math.floor(lowHz / hzPerBin));
  const endBin = Math.min(fft.length - 1, Math.ceil(highHz / hzPerBin));
  if (endBin <= startBin) {
    return;
  }

  const slice = [];
  for (let i = startBin; i <= endBin; i += 1) {
    slice.push({ index: i, db: fft[i], hz: i * hzPerBin });
  }

  const sortedByPower = [...slice].sort((a, b) => b.db - a.db);
  const strongest = sortedByPower.slice(0, 5).filter((item) => Number.isFinite(item.db));
  const medianDb = percentile(slice.map((item) => item.db).filter(Number.isFinite), 0.5);
  const peak = strongest[0];
  const activityScore = peak ? peak.db - medianDb : 0;

  els.ft8NoiseFloor.textContent = Number.isFinite(medianDb) ? `${medianDb.toFixed(1)} dB` : "-- dB";
  els.ft8PeakTone.textContent = peak ? `${peak.hz.toFixed(1)} Hz` : "-- Hz";
  els.ft8Activity.textContent = activityScore > 12 ? "Strong" : activityScore > 6 ? "Moderate" : "Weak";
}

export function renderDecoderCandidates() {
  if (!els.ft8DecoderList) return;
  if (!ft8State.decoderCandidates.length) {
    els.ft8DecoderList.innerHTML =
      '<div class="empty-state">Frame sync and extracted-symbol notes will appear here after enough buffered audio is collected.</div>';
    return;
  }

  els.ft8DecoderList.innerHTML = ft8State.decoderCandidates
    .map(
      (candidate, index) => `
        <div class="ft8-candidate">
          <strong>${escapeHtml(candidate.text || `Candidate ${index + 1}: ${candidate.hz.toFixed(1)} Hz`)}</strong>
          <span>Approx. SNR ${candidate.snr.toFixed(1)} dB relative to local floor</span>
          <span>Power ${candidate.db.toFixed(1)} dBFS during slot ${candidate.slot}</span>
        </div>
      `
    )
    .join("");
}

export function analyzeFt8Frames() {
  const sampleRate = ft8State.ft8SampleRate;
  if (!sampleRate || ft8State.ft8SampleBuffer.length < sampleRate * 5) {
    return;
  }

  const now = Date.now();
  const frameSamples = Math.floor(sampleRate * 15);
  const bufferSeconds = ft8State.ft8SampleBuffer.length / sampleRate;

  if (bufferSeconds >= 15 && now - ft8State.lastFrameCaptureAt > 5000) {
    const frame = ft8State.ft8SampleBuffer.slice(-frameSamples);
    const sync = estimateFt8SlotSync(frame, sampleRate);
    const symbolStream = extractFt8SymbolStream(frame, sampleRate, sync);
    const channelBits = extractFt8ChannelBits(symbolStream);
    const systematicBits = channelBits.slice(0, 91);
    const payloadBits = systematicBits.slice(0, 77);
    ft8State.syncQuality = sync.quality;
    ft8State.lastFrameCaptureAt = now;
    ft8State.lastSymbolStream = symbolStream;
    ft8State.lastChannelBits = channelBits;
    ft8State.lastSystematicBits = systematicBits;
    ft8State.lastPayloadBits = payloadBits;
    els.ft8LastFrame.textContent = new Date(now).toLocaleTimeString();
    els.ft8DecoderStatus.textContent = sync.quality > 0.65 ? "Frame Synced" : "Collecting Sync";
    if (els.ft8SymbolStream) els.ft8SymbolStream.value = formatSymbolStream(symbolStream);
    if (els.ft8ChannelBits) els.ft8ChannelBits.value = formatChannelBits(channelBits, systematicBits);
    if (els.ft8PayloadBits) els.ft8PayloadBits.value = formatPayloadBits(payloadBits, systematicBits);

    ft8State.decoderCandidates = [
      {
        id: `frame-${now}`,
        hz: sync.peakHz,
        db: sync.peakDb,
        snr: sync.quality * 20,
        slot: els.ft8SlotLabel.textContent,
        text: sync.quality > 0.65
          ? `FT8 frame sync candidate near ${sync.peakHz.toFixed(1)} Hz with ${symbolStream.length} extracted symbols, ${channelBits.length} channel bits, and a tentative ${payloadBits.length}-bit payload`
          : "Frame captured, but sync confidence is still low for text decode"
      },
      ...ft8State.decoderCandidates.slice(0, 5)
    ];
    renderDecoderCandidates();

  }
}

function estimateFt8SlotSync(frame, sampleRate) {
  const blockSize = Math.max(256, Math.floor(sampleRate * 0.16));
  const envelope = [];

  for (let offset = 0; offset + blockSize <= frame.length; offset += blockSize) {
    let energy = 0;
    for (let i = offset; i < offset + blockSize; i += 1) {
      const value = frame[i];
      energy += value * value;
    }
    envelope.push(Math.sqrt(energy / blockSize));
  }

  const min = Math.min(...envelope);
  const max = Math.max(...envelope);
  const contrast = max > 0 ? (max - min) / max : 0;

  let zeroCrossings = 0;
  for (let i = 1; i < frame.length; i += 1) {
    if ((frame[i - 1] <= 0 && frame[i] > 0) || (frame[i - 1] >= 0 && frame[i] < 0)) {
      zeroCrossings += 1;
    }
  }

  const durationSeconds = frame.length / sampleRate;
  const estimatedToneHz = durationSeconds > 0 ? zeroCrossings / (2 * durationSeconds) : 0;
  const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
  const peakDb = rms > 0 ? 20 * Math.log10(rms) : -120;

  return {
    quality: Math.max(0, Math.min(0.99, contrast * 1.8)),
    peakHz: estimatedToneHz,
    peakDb,
    baseToneHz: estimatedToneHz
  };
}

export function updateFrameCaptureUi() {
  if (!ft8State.ft8SampleRate || !ft8State.ft8SampleBuffer.length) {
    els.ft8FrameBuffer.textContent = "0.0 s";
    els.ft8SyncQuality.textContent = "--";
    if (!ft8State.lastFrameCaptureAt) {
      els.ft8LastFrame.textContent = "None";
    }
    return;
  }

  els.ft8FrameBuffer.textContent = `${(ft8State.ft8SampleBuffer.length / ft8State.ft8SampleRate).toFixed(1)} s`;
  els.ft8SyncQuality.textContent = `${Math.round(ft8State.syncQuality * 100)}%`;
}

export function updateFt8AutoSeqUi() {
  const btn = document.querySelector("#ft8-auto-seq-btn");
  if (!btn) return;
  btn.classList.toggle("active", ft8State.ft8AutoSeq);
  if (ft8State.ft8AutoSeq) {
    btn.textContent = "Auto ✓";
    btn.title = "Auto-sequencing ON — decodes advance the selected message. Click to disable.";
  } else {
    btn.textContent = "Auto";
    btn.title = "Auto-sequencing OFF — click to enable";
  }
  btn.classList.remove("wd-warn");
}

// 4-char Maidenhead field (e.g. "FN31ab" → "FN31") from a plain grid string.
export function ft8GridField(value) {
  const m = /^([A-R]{2}\d{2})/.exec(normalizeToken(value || ""));
  return m ? m[1] : "";
}

// Reduce a callsign to its base form (strip /P, /QRP, prefix calls like PJ4/K1ABC)
// for the loose comparisons WSJT-X does with Radio::base_callsign.
function ft8BaseCall(call) {
  const c = normalizeToken(call || "");
  if (!c || !c.includes("/")) return c;
  const parts = c.split("/").filter(Boolean);
  // The base is the full call: a digit followed by the suffix letters (so "K1ABC"
  // wins over the bare prefix "PJ4" or the "/P" add-on); fall back to longest.
  return parts.find((p) => /\d[A-Z]+$/.test(p)) || parts.sort((a, b) => b.length - a.length)[0] || c;
}

// Numeric rank of how far *our own* side of the QSO has progressed, derived from
// the current QSO stage. Mirrors WSJT-X's QSOProgress ladder
// (CALLING<REPLYING<REPORT<ROGER_REPORT<ROGERS<SIGNOFF) so auto-seq can refuse to
// honour out-of-sequence roger/73 messages and detect the in-QSO state.
function ft8OwnStageRank() {
  const s = (ft8State.ft8QsoStage || "").toLowerCase();
  if (s.includes("rr73")) return 5;   // ROGERS  (sent RR73)
  if (s.includes("73")) return 6;     // SIGNOFF (sent/got 73)
  if (s.includes("r-report")) return 4; // ROGER_REPORT
  if (s.includes("report")) return 3; // REPORT
  if (s.includes("reply") || s.includes("grid")) return 2; // REPLYING
  if (s.includes("cq")) return 1;     // CALLING
  return 0;                           // Standby
}

// True when a decode shows the station we're working (dxCall) transmitting to a
// *third party* rather than to us — i.e. they've started another QSO. Standard
// FT8 messages are "TO FROM payload"; we want FROM == our DX and TO == someone
// else (a real call, not us / CQ / QRZ / DE).
function ft8DecodeIsDxWorkingOther(text, dxCall, myCall) {
  const norm = normalizeToken(text).replace(/\s+/g, " ").trim();
  if (!norm) return false;
  const t = norm.split(" ");
  if (t.length < 3) return false;
  const to = t[0].replace(/[<>]/g, "");
  const from = t[1].replace(/[<>]/g, "");
  if (!to || !from) return false;
  if (to === "CQ" || to === "QRZ" || to === "DE") return false;
  if (ft8BaseCall(from) !== ft8BaseCall(dxCall)) return false; // sender isn't our DX
  if (ft8BaseCall(to) === ft8BaseCall(myCall)) return false;   // it's actually for us
  // TO must look like a callsign (letter + digit), not a grid/report/<...> hash.
  if (!/[A-Z]/.test(to) || !/\d/.test(to)) return false;
  return true;
}

// Returns true if it advanced the QSO on a directed message (so an early-decode
// pass can mark the slot handled); false for no-op / watchdog paths.
// With directedOnly (the early pass), only the directed-message advances run —
// repeats and the watchdog live in the TX scheduler (ft8SchedulerTick).
export function advanceFt8AutoSeq(decoded, slotMs, { directedOnly = false } = {}) {
  if (!ft8State.ft8AutoSeq) return false;
  // Block only while the waveform is actually playing — a dispatch that hasn't
  // reached the air yet is cancelled and re-dispatched by selectFt8Message
  // when a more advanced stage is decoded.
  if (ft8State.ft8TxStatus === "Transmitting") return false;
  const myCall = normalizeToken(els.ft8MyCall.value);
  if (!myCall) return false;
  const activeDxCall = normalizeToken(els.ft8DxCall.value);

  // Answer the strongest caller first (WSJT-X considers signal strength when
  // several stations reply to a CQ), rather than whatever the decoder emitted first.
  const ordered = [...decoded].sort((a, b) => (b.db ?? -99) - (a.db ?? -99));

  // QRM auto-stop (WSJT-X auto_sequence "auto stop to avoid accidental QRM"):
  // once we're committed to a DX (past CQ), if that station is decoded working
  // someone else, stop calling them instead of repeating into an in-progress QSO.
  // Boundary pass only — the early pass stays purely additive.
  if (!directedOnly && activeDxCall && ft8OwnStageRank() >= 2) {
    if (ordered.some((msg) => ft8DecodeIsDxWorkingOther(msg.text, activeDxCall, myCall))) {
      appendSerialLog(`[AutoSeq] ${activeDxCall} is now working another station — halting calls to avoid QRM.`);
      setFt8TxEnabled(false, `FT8 auto-seq: ${activeDxCall} is working another station — Enable Tx off.`);
      return false;
    }
  }

  for (const msg of ordered) {
    const parsed = parseFt8DecodeText(msg.text);
    if (!parsed) continue;
    const { stage, dxCall } = parsed;
    if (activeDxCall && dxCall !== activeDxCall) continue;

    if (stage === "Grid copied") {
      // They replied to our CQ with their call + grid → send our report
      // (reported at the SNR we actually copied them at).
      applyFt8DecodeToForm(msg.text, slotMs, msg.db);
      appendSerialLog(`[AutoSeq] ${dxCall} replied to CQ → queuing report`);
      selectFt8Message("report");
      return true;
    }
    if (stage === "Report copied") {
      // They sent us a plain signal report → send R+report
      applyFt8DecodeToForm(msg.text, slotMs, msg.db);
      appendSerialLog(`[AutoSeq] ${dxCall} sent report → queuing R+report`);
      selectFt8Message("r-report");
      return true;
    }
    if (stage === "R-report copied") {
      // They rogered our report → acknowledge with RR73 (WSJT-X initiator close).
      applyFt8DecodeToForm(msg.text, slotMs, msg.db);
      appendSerialLog(`[AutoSeq] ${dxCall} sent R+report → queuing RR73`);
      selectFt8Message("rrr");
      return true;
    }
    if (stage === "RRR copied" || stage === "RR73 copied") {
      // Only honour a roger once we've actually exchanged reports (WSJT-X
      // acceptable_73 requires QSOProgress >= ROGER_REPORT); a stray RR73/RRR
      // carrying our call must not "complete" a QSO that never happened.
      if (ft8OwnStageRank() < 3) continue;
      // They confirmed (RR73/RRR) → close with 73 (WSJT-X answerer close), then
      // cease auto-seq: the QSO is complete from our side, so don't repeat the
      // 73 toward the watchdog (WSJT-X cease_auto_Tx_after_QSO). The selected 73
      // still transmits (and auto-logs) via the slot scheduler; parity is left
      // intact so it fires in the correct slot, and its dispatch disarms Enable Tx.
      applyFt8DecodeToForm(msg.text, slotMs, msg.db);
      appendSerialLog(`[AutoSeq] ${dxCall} confirmed (${stage.replace(" copied", "")}) → queuing final 73 and closing`);
      selectFt8Message("73");
      ft8State.ft8AutoSeq = false;
      updateFt8AutoSeqUi();
      return true;
    }
    if (stage === "73 copied") {
      // Same progress gate: ignore a 73 unless we're far enough into the QSO.
      if (ft8OwnStageRank() < 3) continue;
      appendSerialLog(`[AutoSeq] QSO complete with ${dxCall} — turning off auto-seq`);
      ft8State.ft8AutoSeq = false;
      setFt8TxEnabled(false, "QSO complete (73 copied) — Enable Tx off.");
      ft8State.ft8TxParity = null;
      updateFt8AutoSeqUi();
      return true;
    }
  }

  // Early pass found no directed message — leave retries/watchdog to the boundary.
  if (directedOnly) return false;

  // No reply found: nothing to do — while Enable Tx is armed the scheduler
  // repeats the selected message every matching slot (the WSJT-X model), and
  // the scheduler's Tx watchdog bounds runaway calling.
  return false;
}

export async function runFt8Decode(isAuto = false) {
  if (!ft8State.ft8Decoder) {
    appendSerialLog("FT8 decoder is not loaded yet.");
    return;
  }

  if (!ft8State.ft8SampleRate || ft8State.ft8SampleBuffer.length < ft8State.ft8SampleRate * 15) {
    appendSerialLog("Need a full 15-second FT8 audio frame before decoding.");
    return;
  }

  // The ft8js decoder uses shared WASM result buffers, so decodes must not
  // overlap (the early pass can still be running as the boundary arrives).
  if (ft8State.ft8DecodeInFlight) {
    if (!isAuto) appendSerialLog("FT8 decoder busy — try again in a moment.");
    return;
  }
  ft8State.ft8DecodeInFlight = true;

  try {
    els.ft8DecoderStatus.textContent = "Decoding";
    const frame = ft8State.ft8SampleBuffer.slice(-Math.floor(ft8State.ft8SampleRate * 15));
    const resampled = resampleToFt8Rate(frame, ft8State.ft8SampleRate, 12000);
    const decoded = await ft8State.ft8Decoder.decode(resampled);
    const slotMs = ft8State.ft8LastAutoDecodeAt || ft8Now();
    ft8State.ft8DecodedMessages = decoded;
    if (decoded.length) {
      // Annotate each decode once (stable across re-renders): is this a grid we
      // haven't worked/seen yet? Mark it seen so later slots don't re-flag it.
      for (const msg of decoded) {
        const field = ft8FindGridField(msg.text);
        msg.newGrid = !!field && !ft8State.ft8SeenGrids.has(field);
        if (field) ft8State.ft8SeenGrids.add(field);
      }
      ft8State.ft8DecodeHistory.push({ slotMs, messages: decoded });
      if (ft8State.ft8DecodeHistory.length > 10) ft8State.ft8DecodeHistory.shift();
      ft8State.ft8DecodeTimestamps.push(Date.now());
    }
    renderFt8TextDecodes();
    // effectiveMapMode()/renderMap() moved to js/apps/map/index.js.
    // That app reads live ft8DecodeHistory/ft8WorkedCallsigns/session-running
    // state off ctx.ft8 (assigned in ./index.js's mount()) rather
    // than a copy in this event's detail, since both fields get reassigned in
    // place elsewhere (startFt8Session reseeds ft8WorkedCallsigns,
    // stopFt8Session clears ft8DecodeHistory) and a bus payload captured once
    // here would go stale by the time a later, unrelated trigger re-renders
    // the map. detail still carries the latest decoded batch for parity with
    // the old direct call's data shape, though the map app's renderFt8Map()
    // reads the fuller decode history off the bridge instead.
    bus.dispatchEvent(new CustomEvent("ft8-decodes", { detail: ft8State.ft8DecodedMessages }));
    els.ft8DecoderStatus.textContent = decoded.length ? "Text Decoded" : "No Decodes";
    appendSerialLog(`FT8 decoder ${isAuto ? "auto-" : ""}returned ${decoded.length} text decode${decoded.length === 1 ? "" : "s"}.`);
    // Skip auto-seq if the early pass already advanced this signal's slot.
    const signalSlot = slotMs - 15000;
    if (isAuto && ft8State.ft8LastAutoSeqSignalSlot !== signalSlot) {
      advanceFt8AutoSeq(decoded, slotMs);
    }
  } catch (error) {
    els.ft8DecoderStatus.textContent = "Decode Error";
    appendSerialLog(`FT8 decode failed: ${error.message}`);
  } finally {
    ft8State.ft8DecodeInFlight = false;
  }
}

// Build a 15-second decode frame for the *current* (still-running) slot: the
// audio since the slot boundary, front-aligned and zero-padded to 15 s so the
// signal sits at its natural slot position (same alignment as the boundary
// decode). Returns null until enough of the slot has been captured.
function buildEarlySlotFrame() {
  const sr = ft8State.ft8SampleRate;
  if (!sr) return null;
  const now = ft8Now();
  const slotStart = Math.floor(now / 15000) * 15000;
  const haveSamples = Math.floor(((now - slotStart) / 1000) * sr);
  const buf = ft8State.ft8SampleBuffer;
  if (haveSamples < Math.floor(sr * 13) || buf.length < haveSamples) return null;
  const frame = new Float32Array(Math.floor(sr * 15)); // tail stays zero (post-signal silence)
  const slotSamples = buf.slice(buf.length - haveSamples);
  const n = Math.min(slotSamples.length, frame.length);
  for (let i = 0; i < n; i += 1) frame[i] = slotSamples[i];
  return frame;
}

// Decode the current slot ~1.3 s before it ends so an auto-seq reply is encoded
// and ready to fire exactly at the next slot boundary (avoids losing a whole T/R
// cycle when a boundary decode runs long). Best-effort and additive: it writes
// no display history and only drives directed-message advances — the boundary
// decode still runs for display and for retries/late signals.
export async function runFt8EarlyDecode() {
  if (!ft8State.ft8Decoder || !ft8State.ft8AutoSeq || ft8State.ft8DecodeInFlight) return;
  const frame = buildEarlySlotFrame();
  if (!frame) return;
  ft8State.ft8DecodeInFlight = true;
  const signalSlot = Math.floor(ft8Now() / 15000) * 15000;
  try {
    const resampled = resampleToFt8Rate(frame, ft8State.ft8SampleRate, 12000);
    const decoded = await ft8State.ft8Decoder.decode(resampled);
    if (!decoded.length) return;
    // slotMs = signalSlot + 15000 keeps the parity formula identical to the boundary pass.
    const advanced = advanceFt8AutoSeq(decoded, signalSlot + 15000, { directedOnly: true });
    if (advanced) {
      ft8State.ft8LastAutoSeqSignalSlot = signalSlot;
      appendSerialLog("[AutoSeq] Early decode advanced the QSO before the slot boundary.");
    }
  } catch (error) {
    appendSerialLog(`FT8 early decode skipped: ${error.message}`);
  } finally {
    ft8State.ft8DecodeInFlight = false;
  }
}

export function parseFt8DecodeText(text) {
  const normalized = normalizeToken(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const tokens = normalized.split(" ");
  // De-hash 22-bit hashed callsigns the decoder prints in angle brackets:
  // "<K1ABC>" (call known from a recent decode) → usable call; "<...>" (call
  // not yet known) → unusable. Applied only to the two call-bearing positions.
  const dehash = (t) => {
    const m = /^<(.+)>$/.exec(t || "");
    if (!m) return t;
    return /^\.+$/.test(m[1]) ? "" : m[1];
  };
  tokens[0] = dehash(tokens[0]);
  tokens[1] = dehash(tokens[1]);
  const myCall = normalizeToken(els.ft8MyCall.value);
  const gridPattern = /^[A-R]{2}\d{2}([A-X]{2})?$/;
  const reportPattern = /^R?[+-]\d{2}$/;

  if (tokens[0] === "CQ" && tokens[1]) {
    // tokens[1] may be a direction qualifier — use explicit allowlist, not a heuristic
    const CQ_QUALIFIERS = new Set(["DX","NA","SA","EU","AF","AS","OC","AN","TEST","POTA","SOTA","WW","DXP","FD","RU","QRP","WWFF","IOTA"]);
    const hasDir = CQ_QUALIFIERS.has(tokens[1]);
    const dxCall = hasDir ? (tokens[2] || "") : tokens[1];
    const gridToken = hasDir ? tokens[3] : tokens[2];
    const dxGrid = gridPattern.test(gridToken || "") ? gridToken : "";
    if (!dxCall) return null;
    return {
      dxCall,
      dxGrid,
      receivedReport: "",
      stage: "CQ copied",
      summary: hasDir ? `CQ ${tokens[1]} from ${dxCall}` : `CQ from ${dxCall}`
    };
  }

  if (!myCall || tokens.length < 3) {
    return null;
  }

  const fromMyCall = tokens[0] === myCall;
  const toMyCall = tokens[1] === myCall;
  if (!fromMyCall && !toMyCall) {
    return null;
  }

  const dxCall = fromMyCall ? tokens[1] : tokens[0];
  if (!dxCall) return null; // unusable (e.g. unknown <...> hash in the DX position)
  const payload = tokens[2];
  const summaryParts = [`DX ${dxCall}`];
  const result = { dxCall, dxGrid: "", receivedReport: "", stage: "In contact", summary: "" };

  // Literal roger/signoff tokens are checked before gridPattern because "RR73"
  // also matches a Maidenhead grid (RR + 73); in message context it is the
  // roger-73 token, not a grid square.
  if (payload === "RR73") {
    result.stage = "RR73 copied";
    summaryParts.push("RR73 copied");
  } else if (payload === "RRR") {
    result.stage = "RRR copied";
    summaryParts.push("RRR copied");
  } else if (payload === "73") {
    result.stage = "73 copied";
    summaryParts.push("73 copied");
  } else if (gridPattern.test(payload)) {
    result.dxGrid = payload;
    result.stage = "Grid copied";
    summaryParts.push(`grid ${payload}`);
  } else if (reportPattern.test(payload)) {
    result.receivedReport = payload.replace(/^R/, "");
    result.stage = payload.startsWith("R") ? "R-report copied" : "Report copied";
    summaryParts.push(`report ${payload}`);
  } else {
    summaryParts.push(payload);
  }

  result.summary = summaryParts.join(", ");
  return result;
}

function resampleToFt8Rate(samples, inputRate, targetRate) {
  if (inputRate === targetRate) {
    return new Float32Array(samples);
  }

  const ratio = inputRate / targetRate;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += samples[j];
      count += 1;
    }
    output[i] = count ? sum / count : 0;
  }

  return output;
}

function extractFt8SymbolStream(frame, sampleRate, sync) {
  const symbolCount = 79;
  const symbolDurationSeconds = 0.160;
  const symbolLength = Math.max(64, Math.floor(sampleRate * symbolDurationSeconds));
  const startOffset = Math.max(0, frame.length - symbolCount * symbolLength);
  const passbandLow = 200;
  const passbandHigh = 3000;
  const toneSpacing = 6.25;
  const baseToneHz = estimateFt8BaseTone(frame, sampleRate, startOffset, symbolLength, passbandLow, passbandHigh, sync?.baseToneHz || passbandLow);
  const symbols = [];

  for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex += 1) {
    const begin = startOffset + symbolIndex * symbolLength;
    const end = Math.min(frame.length, begin + symbolLength);
    if (end - begin < 16) {
      break;
    }
    let bestTone = 0;
    let bestPower = -Infinity;

    for (let tone = 0; tone < 8; tone += 1) {
      const hz = baseToneHz + tone * toneSpacing;
      const power = goertzelMagnitude(frame, begin, end, sampleRate, hz);
      if (power > bestPower) {
        bestPower = power;
        bestTone = tone;
      }
    }

    symbols.push({
      index: symbolIndex,
      tone: bestTone,
      hz: baseToneHz + bestTone * toneSpacing,
      amplitude: bestPower
    });
  }

  return symbols;
}

function formatSymbolStream(symbols) {
  if (!symbols.length) {
    return "";
  }

  const toneLine = symbols.map((symbol) => symbol.tone).join("");
  const hzPreview = symbols
    .slice(0, 12)
    .map((symbol) => `${symbol.hz.toFixed(0)}Hz`)
    .join(" ");

  return `Tones (${symbols.length}): ${toneLine}\nFirst symbols: ${hzPreview}`;
}

function estimateFt8BaseTone(frame, sampleRate, startOffset, symbolLength, passbandLow, passbandHigh, fallbackHz) {
  let bestBase = Math.max(passbandLow, Math.min(passbandHigh - 7 * 6.25, fallbackHz));
  let bestScore = -Infinity;

  for (let base = passbandLow; base <= passbandHigh - 7 * 6.25; base += 6.25) {
    let score = 0;
    for (const blockStart of FT8_SYNC_BLOCK_STARTS) {
      for (let offset = 0; offset < FT8_COSTAS_SEQUENCE.length; offset += 1) {
        const symbolIndex = blockStart + offset;
        const begin = startOffset + symbolIndex * symbolLength;
        const end = begin + symbolLength;
        if (end > frame.length) {
          continue;
        }
        const expectedHz = base + FT8_COSTAS_SEQUENCE[offset] * 6.25;
        score += goertzelMagnitude(frame, begin, end, sampleRate, expectedHz);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestBase = base;
    }
  }

  return bestBase;
}

function goertzelMagnitude(samples, begin, end, sampleRate, targetHz) {
  const length = end - begin;
  if (length <= 0) {
    return -Infinity;
  }

  const k = Math.round((length * targetHz) / sampleRate);
  const omega = (2 * Math.PI * k) / length;
  const coeff = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  for (let i = begin; i < end; i += 1) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }

  const power = q1 * q1 + q2 * q2 - coeff * q1 * q2;
  return power > 0 ? 10 * Math.log10(power) : -120;
}

function extractFt8ChannelBits(symbols) {
  if (!symbols.length) {
    return "";
  }

  const dataSymbols = symbols.filter((symbol) => !isFt8SyncSymbol(symbol.index)).slice(0, 58);
  return dataSymbols.map((symbol) => FT8_GRAY_BITS[symbol.tone] || "000").join("");
}

function isFt8SyncSymbol(index) {
  return FT8_SYNC_BLOCK_STARTS.some((start) => index >= start && index < start + FT8_COSTAS_SEQUENCE.length);
}

function formatChannelBits(channelBits, systematicBits) {
  if (!channelBits) {
    return "";
  }

  const channelGroups = channelBits.match(/.{1,29}/g) || [];
  const systematicGroups = systematicBits.match(/.{1,29}/g) || [];
  return `Channel bits (${channelBits.length}):\n${channelGroups.join("\n")}\n\nSystematic candidate (${systematicBits.length}):\n${systematicGroups.join("\n")}`;
}

function formatPayloadBits(bits, systematicBits) {
  if (!bits) {
    return "";
  }

  const payloadGroups = bits.match(/.{1,29}/g) || [];
  const typeBits = bits.slice(74, 77);
  return `Payload candidate (${bits.length}):\n${payloadGroups.join("\n")}\n\nType bits guess: ${typeBits || "---"}\nSystematic bits used: ${systematicBits.length}`;
}
