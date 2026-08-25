// FT8 mini-app — the decode/encode console: slot clock, waterfall, decode list,
// TX queue, band activity, and the QSO state machine that hands a completed
// exchange to the logger.
//
// Constraints worth knowing before changing anything here:
//
// - It publishes ctx.ft8 as the FIRST statement of mount(), before any DOM work,
//   so an app mounted later in the loop can see it. The map and radio apps read
//   it. Everything on it is a live getter, not a snapshot: sessionRunning,
//   workedCallsigns and the decode history are all reassigned as sessions start
//   and stop, so a value captured once goes stale.
//
// - It reads ctx.logger the same way — optional-chained at call time — because
//   either app may mount first.
//
// - The decoder is WASM (vendor/ft8js). That needs 'wasm-unsafe-eval' in the
//   CSP and the .wasm files served as application/wasm; both are checked by
//   check.sh and by the Pages build.
//
// - The slot clock corrects local drift against /api/time. FT8 slots are 15
//   seconds and a clock off by more than about a second decodes nothing.
//
// - Standard FT8 messages carry a 4-character grid, so a 6-character locator is
//   truncated before transmission to keep the message protocol-legal.
import { cat } from "../../connectors/cat.js";
import { audio } from "../../connectors/audio.js";
import { logbook } from "../../connectors/logbook.js";
import { bus } from "../../bus.js";
import { appendSerialLog as writeSerialLog } from "../../serial-log.js";
import {
  escapeHtml, normalizeToken, normalizeReport, parseFrequencyText,
  inferBandFromFrequency, wait, FT8_BAND_FREQUENCIES, digiDisplayLabel,
} from "../../utils.js";
import { loadFt8Decoder } from "./ft8-decoder.js";
import { createFt8Encoder } from "./ft8-encoder.js";
import {
  startFt8AudioMonitor, stopFt8AudioMonitor, ensureFt8TxAudioContext,
  applyFt8TxOutputDevice, playFt8Waveform, clearWaterfall, handleWaterfallClick, setTxBlank,
} from "./audio.js";
import {
  FT8_AUTOSEQ_WATCHDOG_MS, updateFt8AutoSeqUi, runFt8Decode, runFt8EarlyDecode,
  ft8GridField, renderDecoderCandidates, updateFrameCaptureUi, parseFt8DecodeText,
} from "./decode.js";

export const ft8State = {
  ft8TimerId: null,
  ft8ClockOffsetMs: 0,
  audioContext: null,
  analyser: null,
  audioSourceNode: null,
  processorNode: null,
  audioStream: null,
  animationFrameId: null,
  decoderCandidates: [],
  lastDecodeAt: 0,
  ft8SampleRate: 0,
  ft8SampleBuffer: [],
  lastFrameCaptureAt: 0,
  syncQuality: 0,
  lastSymbolStream: [],
  lastPayloadBits: "",
  lastChannelBits: "",
  lastSystematicBits: "",
  ft8Decoder: null,
  ft8Encoder: null,
  ft8DecodedMessages: [],
  ft8DecodeHistory: [],
  ft8WorkedCallsigns: new Set(),
  ft8TxParity: null,
  ft8AutoSeq: false,
  ft8AutoSeqDeadline: 0,
  ft8ClockSyncTimer: null,
  ft8LastAutoDecodeAt: 0,
  ft8LastEarlyDecodeAt: 0,
  ft8LastAutoSeqSignalSlot: -1,
  ft8DecodeInFlight: false,
  ft8TxAudioContext: null,
  ft8TxSourceNode: null,
  ft8TxGainNode: null,
  ft8TxMediaDest: null,
  ft8TxSinkEl: null,
  ft8TxEnabled: false,
  ft8SelectedAction: null,
  ft8LastDispatchedSlot: -1,
  ft8TxQueuedMessage: null,
  ft8TxStatus: "Idle",
  ft8QsoStage: "Standby",
  ft8LastTxText: "",
  ft8TxHistory: [],
  ft8LogQueue: [],
  ft8TxInProgress: false,
  ft8TuneInProgress: false,
  ft8TuneOscillator: null,
  ft8TuneTimerId: null,
  ft8DecodeTimestamps: [],
  ft8SeenGrids: new Set(),
};

const els = {};

// Stashed by mount() (see below) so top-level functions in this file — which
// aren't nested inside mount() the way logger/radio's are — can still reach
// ctx.logger at call time. Do NOT capture ctx.logger itself here; capture
// ctx and read ctx.logger?.x lazily so a QSO logged before the logger app
// mounts still resolves the "not ready" guard correctly instead of a stale
// undefined.
let appCtx = null;

// ── Shell seams: thin dispatchers over bus events another mini-app's real
// implementation listens for (same shape as every other mini-app's copy —
// see js/apps/radio/index.js's header note). ──────────────────────────────
// Was a bus "serial-log" dispatch that the RADIO app listened for and forwarded
// to its own identical copy of the write. That made every FT8 log line depend on
// the radio app having mounted; it writes the shared strip directly now.
// Re-exported under the original name because ~38 call sites in this file (and
// js/apps/ft8/decode.js) use it.
export const appendSerialLog = writeSerialLog;

function updateFreqBandChip() {
  bus.dispatchEvent(new CustomEvent("freq-band-chip-refresh"));
}

// thin dispatcher mirroring updateFreqBandChip
// above — the real body lives in js/apps/radio/index.js.
function updateModeQuickButtons() {
  bus.dispatchEvent(new CustomEvent("mode-quickset-refresh"));
}

function syncRadioConsole() {
  bus.dispatchEvent(new CustomEvent("radio-console-sync"));
}

async function initializeFt8Decoder() {
  try {
    els.ft8DecoderStatus.textContent = "Decoder Loading";
    ft8State.ft8Decoder = await loadFt8Decoder();
    ft8State.ft8Encoder = createFt8Encoder(ft8State.ft8Decoder);
    els.ft8DecoderStatus.textContent = "Decoder Ready";
    appendSerialLog("FT8 text decoder loaded with FT8 encoder backend.");
  } catch (error) {
    els.ft8DecoderStatus.textContent = "Decoder Error";
    appendSerialLog(`FT8 decoder load failed: ${error.message}`);
  }
}

function updateFftLabel() {
  if (els.whSpectrumFftLabel && els.ft8FftSize) {
    els.whSpectrumFftLabel.textContent = els.ft8FftSize.value;
  }
  if (els.ft8WfFftLabel && els.ft8FftSize) {
    els.ft8WfFftLabel.textContent = els.ft8FftSize.value;
  }
}

// Fill the logger's frequency/band/mode fields with an FT8 default (button on
// the FT8 tab). Per the brief's Interfaces note, the log-form write moves to
// js/apps/logger/index.js via bus "ft8-log-defaults" instead of reaching into
// logger DOM directly.
function applyFt8Defaults() {
  const profile = cat.getProfile();
  const digiMode = profile.modes.find(m => digiDisplayLabel(m.label));
  if (digiMode) cat.setStagedMode(digiMode.value);
  const selectedBand = document.querySelector("#band")?.value || "20m";
  const hz = FT8_BAND_FREQUENCIES[selectedBand] || FT8_BAND_FREQUENCIES["20m"];
  const band = inferBandFromFrequency(hz);
  cat.setStagedFrequency(hz);
  const mhz = (hz / 1e6).toFixed(3);
  bus.dispatchEvent(new CustomEvent("ft8-log-defaults", { detail: { band, mode: "FT8", frequency: mhz } }));
  updateFreqBandChip();
  updateModeQuickButtons();
  syncRadioConsole();
  appendSerialLog(`Loaded FT8 defaults: ${band} ${mhz} MHz on ${profile.name}.`);
}

// Cross-fill the current FT8 exchange (DX call/grid, reports, session notes)
// into the logger's QSO form. Same "log form -> logger app" split as
// applyFt8Defaults above.
function syncFt8ToLog() {
  const dxCall = els.ft8DxCall.value.trim().toUpperCase();
  const dxGrid = els.ft8DxGrid.value.trim().toUpperCase();
  const detail = {
    callsign: dxCall,
    // DX grid rides along so the logged QSO plots on the map (the logger keeps
    // it in a hidden field — there is no visible Grid Square input).
    gridSquare: dxGrid,
    rstSent: els.ft8SentReport.value.trim(),
    rstReceived: els.ft8ReceivedReport.value.trim(),
    mode: "FT8",
    notes: els.ft8SessionNotes.value.trim(),
  };

  const rawFrequency = cat.getFrequency();
  if (rawFrequency) {
    const hz = parseFrequencyText(rawFrequency);
    detail.frequency = hz ? (hz / 1e6).toFixed(3) : rawFrequency;
  }

  bus.dispatchEvent(new CustomEvent("ft8-log-exchange", { detail }));
  updateModeQuickButtons();
  if (rawFrequency) {
    updateFreqBandChip();
  }
}

// Light up the FT8 band quick-select button matching the current frequency.
function highlightFt8BandRow(frequencyHz) {
  const band = inferBandFromFrequency(frequencyHz);
  document.querySelectorAll("#ft8-band-row button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.ft8Band === band);
  });
}

function isFt8SessionRunning() {
  return !!ft8State.ft8TimerId;
}

// the map app (js/apps/map/index.js)
// owns effectiveMapMode() and renderFt8Map(), but both need live reads of
// FT8 session/decode state — isFt8SessionRunning() (for "auto" map-mode
// resolution) and ft8DecodeHistory/ft8WorkedCallsigns (for the FT8 map
// layer's markers and worked/CQ/new-grid coloring). All three are reassigned
// in place at various points (startFt8Session reseeds ft8WorkedCallsigns,
// stopFt8Session clears ft8DecodeHistory, runFt8Decode mutates both), so a
// one-shot bus payload captured at "ft8-decodes" dispatch time would go
// stale by the time a later, unrelated trigger (tab switch, POTA refresh,
// mode toggle, QSO log change...) asks the map to re-render. Live getters —
// assigned onto ctx.ft8 at the top of mount(), below — read fresh on every
// map render instead of copying data across.
//
// js/apps/radio/index.js reuses this same ctx.ft8 object for two more FT8
// reads it needs: sendCwMacro refuses to key CW mid-FT8-transmission
// (txInProgress), and updateMissionDashboard needs to prune+report
// ft8DecodeTimestamps once a second (pruneDecodeTimestamps(cutoffMs) does
// the same filter+reassign+report-length step the old inline
// updateMissionDashboard body did). Assigned inside mount() (see below,
// first statement) instead of at module top level, since ctx only exists
// once mount(panelEl, ctx) runs — main.js's shared `ctx` reference means
// every other app that reads ctx.ft8 lazily still sees it as soon as this
// app's mount() runs, same timing the old module-top-level assignment gave.

export function ft8Now() {
  return Date.now() + ft8State.ft8ClockOffsetMs;
}

async function syncFt8Clock() {
  try {
    const offsets = [];
    for (let i = 0; i < 3; i++) {
      const t1 = Date.now();
      const res = await fetch("/api/time", { cache: "no-store" });
      const t2 = Date.now();
      const { serverMs } = await res.json();
      offsets.push(serverMs + Math.round((t2 - t1) / 2) - t2);
    }
    offsets.sort((a, b) => a - b);
    ft8State.ft8ClockOffsetMs = offsets[1]; // median of 3 probes
    const sign = ft8State.ft8ClockOffsetMs >= 0 ? "+" : "";
    appendSerialLog(`FT8 clock synced (3-probe median): offset ${sign}${ft8State.ft8ClockOffsetMs} ms`);
  } catch {
    appendSerialLog("FT8 clock sync failed — using system clock.");
  }
}

function startFt8Timer() {
  if (ft8State.ft8TimerId) {
    return;
  }

  updateFt8Clock();
  ft8State.ft8TimerId = window.setInterval(updateFt8Clock, 100);
}

function stopFt8Timer() {
  if (!ft8State.ft8TimerId) {
    return;
  }

  window.clearInterval(ft8State.ft8TimerId);
  ft8State.ft8TimerId = null;
}

async function startFt8Session() {
  // Build worked-callsigns set from log (current band)
  const curBand = inferBandFromFrequency(cat.getStagedFrequency() || 0);
  ft8State.ft8WorkedCallsigns = new Set(
    logbook.qsos()
      .filter(q => !curBand || q.band === curBand)
      .map(q => (q.callsign || "").toUpperCase())
      .filter(Boolean)
  );
  // Seed "new grid" tracking from the log: a grid is new if its 4-char field
  // (e.g. FN31) isn't already worked. WSJT-X tracks grid fields, not subsquares.
  ft8State.ft8SeenGrids = new Set(
    logbook.qsos()
      .map(q => ft8GridField(q.gridSquare))
      .filter(Boolean)
  );

  startFt8Timer();
  await startFt8AudioMonitor();

  // Sync clock after audio is running — awaiting network probes before getUserMedia
  // causes Firefox to reject the mic request when the probes fail.
  void syncFt8Clock();
  if (ft8State.ft8ClockSyncTimer) clearInterval(ft8State.ft8ClockSyncTimer);
  ft8State.ft8ClockSyncTimer = window.setInterval(() => void syncFt8Clock(), 5 * 60 * 1000);

  updateFt8TxUi();
  // Auto map mode keys off the session timer, so flip the map to FT8 now rather
  // than waiting for the first decode cycle (symmetric with stopFt8Session).
  bus.dispatchEvent(new CustomEvent("map-refresh"));
}

async function stopFt8Session() {
  if (ft8State.ft8ClockSyncTimer) { clearInterval(ft8State.ft8ClockSyncTimer); ft8State.ft8ClockSyncTimer = null; }
  ft8State.ft8AutoSeq = false;
  if (ft8State.ft8TxEnabled) setFt8TxEnabled(false, "FT8 session stopped — Enable Tx off.");
  ft8State.ft8SelectedAction = null;
  ft8State.ft8LastDispatchedSlot = -1;
  ft8State.ft8TxParity = null;
  ft8State.ft8DecodeHistory = [];
  // js/apps/map/index.js listens for this to run its own auto-mode-only
  // disconnectPskReporter(), at the same point in the stop sequence (before
  // the tune/transmission/audio teardown below).
  bus.dispatchEvent(new CustomEvent("ft8-session-stopping"));
  if (ft8State.ft8TuneInProgress) await stopFt8Tune();
  await abortFt8Transmission();
  stopFt8Timer();
  await stopFt8AudioMonitor();
  if (ft8State.ft8TxAudioContext) {
    await ft8State.ft8TxAudioContext.close();
    ft8State.ft8TxAudioContext = null;
    ft8State.ft8TxGainNode = null;
    ft8State.ft8TxMediaDest = null;
    if (ft8State.ft8TxSinkEl) {
      ft8State.ft8TxSinkEl.srcObject = null;
      ft8State.ft8TxSinkEl = null;
    }
  }
  updateFt8TxUi();
  bus.dispatchEvent(new CustomEvent("map-refresh"));
}

function updateFt8Clock() {
  const now = ft8Now();
  const secondsIntoCycle = (now / 1000) % 15;
  const slotNumber = Math.floor((now / 1000 / 15) % 100);
  const timeRemaining = 15 - secondsIntoCycle;
  const isEven = slotNumber % 2 === 0;
  const parity = isEven ? "Even" : "Odd";

  // Legacy text elements (still in DOM)
  els.ft8SlotLabel.textContent = `UTC :${slotNumber % 2 === 0 ? "00" : "30"}`;
  els.ft8Countdown.textContent = timeRemaining.toFixed(1);

  // Slot ring animation (circumference = 2π × 25 ≈ 157.08)
  if (els.ft8SlotRingFill) {
    const circumference = 157.08;
    const progress = secondsIntoCycle / 15; // 0 → 1
    els.ft8SlotRingFill.style.strokeDashoffset = String(circumference * (1 - progress));
  }

  // Slot parity + TX/RX indicator
  if (els.ft8SlotParity) {
    const txActive = ft8State.ft8TxInProgress;
    const parityLabel = isEven ? "EVEN" : "ODD";
    const rxTxLabel = txActive ? "TX" : "RX";
    els.ft8SlotParity.textContent = `${parityLabel} · ${rxTxLabel}`;
  }

  // Update TX card data-state
  if (els.ft8TxCard) {
    const st = ft8State.ft8TxStatus;
    let cardState = "idle";
    if (st === "Transmitting" || st === "PTT On" || st === "Encoding") {
      cardState = "tx";
    } else if (st.startsWith("Queued") || st === "TX Error") {
      cardState = "queued";
    } else if (ft8State.ft8TxEnabled) {
      cardState = "armed";
    }
    els.ft8TxCard.dataset.state = cardState;
  }

  // Update the freq card from radio state
  const hz = cat.getStagedFrequency() || parseFrequencyText(cat.getFrequency());
  if (hz > 0 && els.ft8FreqMhz) {
    const mhz = hz / 1_000_000;
    const parts = mhz.toFixed(6).split(".");
    const intPart = parts[0];
    const fracPart = (parts[1] || "000000").substring(0, 6);
    const mainFrac = fracPart.substring(0, 3);
    const subFrac = fracPart.substring(3);
    els.ft8FreqMhz.textContent = `${intPart}.${mainFrac}`;
    const uEl = els.ft8FreqMhz.parentElement?.querySelector(".ft8-freq-u");
    if (uEl) uEl.textContent = `.${subFrac}`;
  }
  if (els.ft8FreqBand) {
    const band = hz > 0 ? inferBandFromFrequency(hz) : "—";
    els.ft8FreqBand.textContent = band || "—";
  }

  // Update TX marker position from TX tone
  if (els.ft8WfTxMarker && els.ft8TxTone) {
    const toneHz = Number(els.ft8TxTone.value) || 1500;
    const pct = ((toneHz - 200) / (3000 - 200)) * 100;
    els.ft8WfTxMarker.style.left = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
    els.ft8WfTxMarker.dataset.label = `TX ${toneHz}`;
  }

  // Update decodes-per-minute display
  if (els.ft8DecodesRate) {
    const cutoff = now - 60_000;
    const recentCount = ft8State.ft8DecodeTimestamps.filter(t => t > cutoff).length;
    els.ft8DecodesRate.textContent = `${recentCount}/MIN`;
  }

  // Update waterfall FFT label
  if (els.ft8WfFftLabel && els.ft8FftSize) {
    els.ft8WfFftLabel.textContent = els.ft8FftSize.value;
  }

  // Fire WASM decode at the start of each 15-second slot boundary
  if (secondsIntoCycle < 0.5 && ft8State.audioContext && ft8State.ft8Decoder) {
    const slotStart = Math.floor(now / 15000) * 15000;
    const minSamples = (ft8State.ft8SampleRate || 12000) * 15;
    if (slotStart > ft8State.ft8LastAutoDecodeAt && ft8State.ft8SampleBuffer.length >= minSamples) {
      ft8State.ft8LastAutoDecodeAt = slotStart;
      void runFt8Decode(true);
    }
  }

  // Early decode ~1.3 s before the slot ends (auto-seq only) so a reply is encoded
  // and ready to fire on the boundary instead of racing a slow boundary decode.
  if (ft8State.ft8AutoSeq && secondsIntoCycle >= 13.5 && secondsIntoCycle < 14.6
      && ft8State.audioContext && ft8State.ft8Decoder) {
    const slotStart = Math.floor(now / 15000) * 15000;
    if (slotStart > ft8State.ft8LastEarlyDecodeAt) {
      ft8State.ft8LastEarlyDecodeAt = slotStart;
      void runFt8EarlyDecode();
    }
  }

  // Keep the Tx watchdog countdown ticking while auto-seq / Enable Tx run.
  if (ft8State.ft8AutoSeq) updateFt8AutoSeqUi();
  if (ft8State.ft8TxEnabled) updateFt8EnableTxUi();
  ft8SchedulerTick();
}

export function updateFt8TxUi() {
  const tone = clampFt8Tone(Number(els.ft8TxTone.value) || 1500);
  els.ft8TxTone.value = String(tone);
  els.ft8TxToneReadout.textContent = `${tone} Hz`;
  // Linearity hint: most rigs transmit cleanest with the audio tone in roughly
  // 300–2700 Hz. Flag tones near/outside the SSB passband edges so the operator
  // can move within the linear region (WebHam feeds the tone straight to the
  // rig's modulator, so unlike WSJT-X there is no dial-shift "Fake It" to hide it).
  const toneLinear = tone >= 300 && tone <= 2700;
  els.ft8TxToneReadout.classList.toggle("ft8-tone-warn", !toneLinear);
  if (els.ft8TxTone) els.ft8TxTone.title = toneLinear
    ? "FT8 audio TX tone"
    : "Tone is near the SSB passband edge — TX may be non-linear. 1000–2000 Hz is safest.";
  updateFt8TxParityUi();
  if (els.whDisplayTxFreq) {
    els.whDisplayTxFreq.value = `${tone}`;
  }
  els.ft8AutoLogStatus.textContent = els.ft8AutoLog.checked ? "AUTO · 73" : "MANUAL";
  els.ft8TxStatus.textContent = ft8State.ft8TxStatus;
  els.ft8QsoStage.textContent = ft8State.ft8QsoStage;
  const queuedText = ft8State.ft8TxQueuedMessage?.text || ft8SelectedMessage()?.text || "—";
  els.ft8NextTx.textContent = queuedText;
  els.ft8LastTx.textContent = ft8State.ft8LastTxText || "None";

  // Update the next-msg mirror in target card
  if (els.ft8NextMsg) {
    els.ft8NextMsg.textContent = queuedText;
  }

  // Update target callsign from DX call field
  if (els.ft8TargetCall) {
    const dxCall = els.ft8DxCall?.value?.trim().toUpperCase() || "";
    els.ft8TargetCall.textContent = dxCall || "—";
  }
  if (els.ft8TargetMeta) {
    const dxGrid = els.ft8DxGrid?.value?.trim().toUpperCase() || "";
    const received = els.ft8ReceivedReport?.value?.trim() || "";
    const tone2 = Number(els.ft8TxTone.value) || 1500;
    const parts = [dxGrid, received ? `${received} dB` : "", `+${tone2} Hz`].filter(Boolean);
    els.ft8TargetMeta.textContent = parts.length > 1 ? parts.join(" · ") : "no target";
  }

  const txActions = document.querySelectorAll(".ft8-tx-actions button");
  const selectedAction = ft8State.ft8SelectedAction;
  txActions.forEach(btn => {
    const idMap = {
      "ft8-queue-cq-btn": "cq",
      "ft8-queue-reply-btn": "reply",
      "ft8-queue-report-btn": "report",
      "ft8-queue-rrr-btn": "rrr",
      "ft8-queue-73-btn": "73"
    };
    const btnAction = idMap[btn.id];
    // No dedicated R+report button — the rogered report shares the Report button,
    // so it stays highlighted through that auto-seq step instead of going blank.
    const match = btnAction === selectedAction ||
      (btnAction === "report" && selectedAction === "r-report");
    btn.classList.toggle("selected", Boolean(selectedAction && match));
  });
  if (els.ft8FreeTextBtn) {
    els.ft8FreeTextBtn.classList.toggle("selected", selectedAction === "freetext");
  }

  // Option B: each message button shows its full built text (live with call/grid).
  const builtByAction = Object.fromEntries(buildFt8Messages().map((m) => [m.action, m.text]));
  const msgBtnMap = {
    "ft8-queue-cq-btn": "cq",
    "ft8-queue-reply-btn": "reply",
    "ft8-queue-report-btn": "report",
    "ft8-queue-rrr-btn": "rrr",
    "ft8-queue-73-btn": "73"
  };
  for (const [id, action] of Object.entries(msgBtnMap)) {
    const textEl = document.getElementById(id)?.querySelector(".ft8-msg-text");
    if (textEl) textEl.textContent = builtByAction[action] || "—";
  }

  updateFt8EnableTxUi();

  // Tune button
  if (els.ft8TuneBtn) {
    els.ft8TuneBtn.disabled = ft8State.ft8TxInProgress;
    els.ft8TuneBtn.textContent = ft8State.ft8TuneInProgress ? "■ Stop" : "Tune";
    els.ft8TuneBtn.classList.toggle("tuning", ft8State.ft8TuneInProgress);
  }

  // Update QSO strip
  updateFt8QsoStrip(ft8State.ft8QsoStage);
}

function updateFt8QsoStrip(stage) {
  if (!els.ft8QsoStripEl) return;
  const steps = els.ft8QsoStripEl.querySelectorAll(".ft8-qso-step");
  // Stage order for comparison
  const stageOrder = [
    "Standby",
    "CQ Queued", "CQ Sent",
    "Reply Queued", "Reply Sent",
    "Report Queued", "Report Sent",
    "RR73 Queued", "RR73 Sent",
    "73 Queued", "73 Sent",
    "Logged"
  ];
  // Which step each button maps to (step data-step → done when stage is at least X)
  const stepDoneAt = {
    cq: "Reply Queued",
    reply: "Report Queued",
    report: "RR73 Queued",
    rrr: "73 Queued",
    "73": "Logged"
  };
  const stepActiveAt = {
    cq: "CQ Queued",
    reply: "Reply Queued",
    report: "Report Queued",
    rrr: "RR73 Queued",
    "73": "73 Queued"
  };
  // Stage strings arrive in mixed case (e.g. "CQ queued" from ft8StageForAction);
  // compare case-insensitively so the strip actually tracks progress.
  const order = stageOrder.map(s => s.toLowerCase());
  const idxOf = (s) => order.indexOf(String(s || "").toLowerCase());
  const currentIdx = idxOf(stage);

  steps.forEach(step => {
    const key = step.dataset.step;
    const doneIdx = idxOf(stepDoneAt[key] || "");
    const activeIdx = idxOf(stepActiveAt[key] || "");
    const isDone = currentIdx >= doneIdx && doneIdx >= 0;
    const isActive = !isDone && currentIdx >= activeIdx && activeIdx >= 0 && currentIdx < doneIdx;
    step.classList.toggle("done", isDone);
    step.classList.toggle("active", isActive);
    const label = step.querySelector("span");
    if (label) {
      if (isDone) label.textContent = "✓";
      else if (isActive) label.textContent = "…";
      else label.textContent = "—";
    }
  });
}

function clampFt8Tone(value) {
  if (!Number.isFinite(value)) {
    return 1500;
  }

  return Math.min(3000, Math.max(200, Math.round(value)));
}

// Manual Tx even/odd override (WSJT-X "Tx even/1st"). Cycles Auto → Even → Odd.
// Auto (null) lets parity be derived from decodes; Even/Odd force the TX slot.
function cycleFt8TxParity() {
  ft8State.ft8TxParity = ft8State.ft8TxParity === null ? "even"
    : ft8State.ft8TxParity === "even" ? "odd" : null;
  updateFt8TxParityUi();
  appendSerialLog(`FT8 TX parity → ${ft8State.ft8TxParity ? ft8State.ft8TxParity.toUpperCase() : "AUTO"}`);
}

function updateFt8TxParityUi() {
  const btn = els.ft8TxParityBtn;
  if (!btn) return;
  const p = ft8State.ft8TxParity;
  btn.textContent = p === "even" ? "Tx Even" : p === "odd" ? "Tx Odd" : "Tx Auto";
  btn.classList.toggle("active", p !== null);
  btn.title = p
    ? `Forcing ${p} slots — click to cycle (Even → Odd → Auto)`
    : "Slot parity auto from decodes — click to force even/odd";
}

// Format a measured SNR (dB) into a valid FT8 signal report, e.g. -7 → "-07",
// 3 → "+03". WSJT-X sends the actual decoded SNR of the station being answered.
function formatFt8Report(db) {
  if (!Number.isFinite(db)) return "";
  const n = Math.max(-30, Math.min(30, Math.round(db)));
  return `${n >= 0 ? "+" : "-"}${String(Math.abs(n)).padStart(2, "0")}`;
}

function flashFt8TxStatus(msg) {
  ft8State.ft8TxStatus = msg;
  updateFt8TxUi();
  window.setTimeout(() => {
    if (ft8State.ft8TxStatus === msg) {
      ft8State.ft8TxStatus = ft8State.ft8TxEnabled ? "Armed" : "Idle";
      updateFt8TxUi();
    }
  }, 3000);
}

// Resolve the currently selected message (text built fresh from the form so
// DX-call edits and auto-seq changes are picked up at dispatch time).
function ft8SelectedMessage() {
  if (!ft8State.ft8SelectedAction) return null;
  if (ft8State.ft8SelectedAction === "freetext") {
    return { action: "freetext", text: normalizeToken(els.ft8FreeText?.value || "") };
  }
  return buildFt8Messages().find((entry) => entry.action === ft8State.ft8SelectedAction) || null;
}

// Select the message that transmits while Enable Tx is armed (WSJT-X Tx1–Tx6
// radio selection). Selection never transmits by itself — the scheduler
// dispatches the selected message each matching slot while ft8TxEnabled is true.
export function selectFt8Message(action) {
  if (action === "freetext") {
    const text = normalizeToken(els.ft8FreeText?.value || "");
    const validationError = validateFt8TransmitRequest("freetext", text);
    if (validationError) {
      flashFt8TxStatus(validationError);
      appendSerialLog(validationError);
      return;
    }
  }
  ft8State.ft8SelectedAction = action;
  // Selection is genuine operator/QSO activity — kick the Tx watchdog forward.
  ft8State.ft8AutoSeqDeadline = ft8Now() + FT8_AUTOSEQ_WATCHDOG_MS;
  // CQ has no slot-partner so parity from a previous QSO shouldn't constrain it.
  if (action === "cq") ft8State.ft8TxParity = null;
  // A dispatch that hasn't reached the air yet carries the old message — cancel
  // it and let the scheduler re-dispatch the new selection (late start covers it).
  if (ft8State.ft8TxInProgress && ft8State.ft8TxStatus !== "Transmitting") {
    void abortFt8Transmission();
    ft8State.ft8LastDispatchedSlot = -1;
  }
  appendSerialLog(`FT8 message selected: ${action.toUpperCase()}`);
  updateFt8TxUi();
}

// Arm / disarm transmission (WSJT-X Enable Tx). Disarming lets a transmission
// already on the air finish; anything not yet playing is cancelled.
export function setFt8TxEnabled(enabled, reason = "") {
  if (enabled === ft8State.ft8TxEnabled) return;
  if (enabled) {
    if (!ft8State.ft8SelectedAction) {
      flashFt8TxStatus("Select a message first");
      appendSerialLog("Enable Tx: select a message (CQ, Reply, …) before arming.");
      return;
    }
    const message = ft8SelectedMessage();
    const validationError = validateFt8TransmitRequest(ft8State.ft8SelectedAction, message?.text || "");
    if (validationError) {
      flashFt8TxStatus(validationError);
      appendSerialLog(validationError);
      return;
    }
    ft8State.ft8TxEnabled = true;
    ft8State.ft8AutoSeqDeadline = ft8Now() + FT8_AUTOSEQ_WATCHDOG_MS;
    if (ft8State.ft8TxStatus === "Idle") ft8State.ft8TxStatus = "Armed";
    startFt8Timer();
    void ensureFt8TxAudioContext();
    appendSerialLog(reason || "FT8 Enable Tx ON — selected message transmits each matching slot.");
  } else {
    ft8State.ft8TxEnabled = false;
    ft8State.ft8LastDispatchedSlot = -1;
    if (ft8State.ft8TxStatus === "Armed" || ft8State.ft8TxStatus === "TX Error") {
      ft8State.ft8TxStatus = "Idle";
    }
    // Cancel a dispatch that hasn't reached the air; let actual playback finish.
    if (ft8State.ft8TxInProgress && ft8State.ft8TxStatus !== "Transmitting") {
      void abortFt8Transmission();
    }
    appendSerialLog(reason || "FT8 Enable Tx OFF.");
  }
  updateFt8TxUi();
}

// Render the Enable Tx button (red + watchdog countdown while armed). Called
// from updateFt8TxUi and ticked from updateFt8Clock so the countdown moves.
function updateFt8EnableTxUi() {
  const btn = els.ft8EnableTxBtn;
  if (!btn) return;
  // The arm button has an icon + static "Enable Tx" label + a state sub-label, so
  // drive those spans rather than overwriting the button's textContent.
  const icon = document.getElementById("ft8-enable-tx-icon");
  const sub = document.getElementById("ft8-enable-tx-sub");
  btn.classList.toggle("armed", ft8State.ft8TxEnabled);
  if (ft8State.ft8TxEnabled) {
    const minsLeft = Math.max(0, Math.ceil((ft8State.ft8AutoSeqDeadline - ft8Now()) / 60000));
    if (icon) icon.textContent = "■";
    if (sub) sub.textContent = `ARMED · WD ${minsLeft}m`;
    btn.classList.toggle("wd-warn", minsLeft <= 1);
    btn.title = `Armed — ${(ft8State.ft8SelectedAction || "").toUpperCase()} transmits each matching slot. Watchdog disarms in ${minsLeft} min without progress. Click to disarm.`;
  } else {
    if (icon) icon.textContent = "▶";
    if (sub) sub.textContent = "TAP TO ARM";
    btn.classList.remove("wd-warn");
    btn.title = "Arm transmission — the selected message transmits every matching slot until disarmed";
  }
}

function validateFt8TransmitRequest(action, text) {
  const myCall = normalizeToken(els.ft8MyCall.value);
  const myGrid = normalizeToken(els.ft8MyGrid.value);
  const dxCall = normalizeToken(els.ft8DxCall.value);

  // Free text: 1–13 chars from the FT8 free-text alphabet (A–Z 0–9 space + - . / ?).
  if (action === "freetext") {
    if (!text) return "Type a free-text message before sending.";
    if (text.length > 13) return "FT8 free text is limited to 13 characters.";
    if (!/^[A-Z0-9 +\-./?]+$/.test(text)) return "Free text may only use A–Z, 0–9, space and + - . / ?";
    return "";
  }

  if (!myCall) {
    return "Enter your callsign before transmitting FT8.";
  }
  if ((action === "cq" || action === "reply") && !myGrid) {
    return "Enter your grid square before sending CQ or an FT8 reply.";
  }
  if (action !== "cq" && !dxCall) {
    return "Enter or stage a DX callsign before transmitting this FT8 message.";
  }
  if (!text || /YOURCALL|YOURGRID|MYCALL|MYGRID|DXCALL|DXGRID/.test(text)) {
    return "Complete the FT8 exchange fields before queueing this message.";
  }

  return "";
}

function getNextFt8SlotTime() {
  const slotLengthMs = 15000;
  const now = ft8Now();
  const msIntoSlot = now % slotLengthMs;
  const currentSlot = Math.floor(now / slotLengthMs);
  const noParityConstraint = !ft8State.ft8TxParity;
  const wantEven = ft8State.ft8TxParity === "even";
  const currentSlotEven = currentSlot % 2 === 0;

  // WSJT-X behavior: start TX immediately if we're early enough in the correct-parity slot.
  const maxLateStartMs = 1500;
  if (msIntoSlot <= maxLateStartMs && (noParityConstraint || currentSlotEven === wantEven)) {
    return now;
  }

  let boundary = (currentSlot + 1) * slotLengthMs;
  if (!noParityConstraint) {
    const nextSlotEven = (currentSlot + 1) % 2 === 0;
    if (nextSlotEven !== wantEven) boundary += slotLengthMs;
  }
  return boundary;
}

// Central TX scheduler (WSJT-X strict model): while Enable Tx is armed,
// dispatch the selected message for each matching-parity slot. Runs from the
// 100 ms FT8 clock tick. The dispatch window opens ~1.5 s before the boundary
// (same timing as the early decode, which can still change the selection and
// trigger a cancel + re-dispatch); arming inside the first 1.5 s of a matching
// slot starts immediately via getNextFt8SlotTime's late-start branch.
function ft8SchedulerTick() {
  if (!ft8State.ft8TxEnabled || !ft8State.ft8SelectedAction) return;
  if (ft8State.ft8TxInProgress || ft8State.ft8TuneInProgress) return;
  if (!ft8State.ft8Encoder) return;

  // Tx watchdog (WSJT-X runaway protection): no QSO progress or operator
  // action within the window disarms Enable Tx instead of calling forever.
  if (ft8Now() > ft8State.ft8AutoSeqDeadline) {
    ft8State.ft8AutoSeq = false;
    updateFt8AutoSeqUi();
    setFt8TxEnabled(false, "FT8 Tx watchdog expired — Enable Tx switched off.");
    return;
  }

  const targetTime = getNextFt8SlotTime();
  if (targetTime - ft8Now() > 1500) return; // dispatch window not open yet
  const slotIndex = Math.floor(targetTime / 15000);
  if (slotIndex <= ft8State.ft8LastDispatchedSlot) return; // this slot is handled
  ft8State.ft8LastDispatchedSlot = slotIndex;
  void dispatchFt8Transmission(targetTime);
}

async function dispatchFt8Transmission(targetTime) {
  const action = ft8State.ft8SelectedAction;
  const message = ft8SelectedMessage();
  const validationError = validateFt8TransmitRequest(action, message?.text || "");
  if (validationError) {
    setFt8TxEnabled(false, `FT8 Enable Tx OFF — ${validationError}`);
    return;
  }
  if (!cat.isConnected()) {
    appendSerialLog("No radio connected — PTT will be skipped, audio-only TX.");
  }

  // First transmission with no parity constraint pins our period to this TX
  // slot (WSJT-X Tx even/odd): repeats land on alternating slots with an RX
  // slot between, never back-to-back. CQ re-selection clears it again.
  if (!ft8State.ft8TxParity) {
    ft8State.ft8TxParity = Math.floor(targetTime / 15000) % 2 === 0 ? "even" : "odd";
    updateFt8TxParityUi();
    appendSerialLog(`FT8 TX parity pinned to ${ft8State.ft8TxParity.toUpperCase()} (first armed transmission).`);
  }

  const toneHz = clampFt8Tone(Number(els.ft8TxTone.value) || 1500);
  const queued = { action, text: message.text, toneHz };
  ft8State.ft8TxQueuedMessage = queued;
  ft8State.ft8TxInProgress = true;
  ft8State.ft8TxStatus = "Encoding";
  ft8State.ft8QsoStage = ft8StageForAction(action, "queued");
  updateFt8TxUi();

  try {
    appendSerialLog(`[TX] Encoding: "${queued.text}" @ ${queued.toneHz} Hz`);
    await ensureFt8TxAudioContext();
    const encoded = await ft8State.ft8Encoder.encodeMessage(queued.text, { toneHz: queued.toneHz });
    appendSerialLog(`[TX] Encode OK: ${encoded.waveform.length} samples, ${encoded.durationSeconds.toFixed(2)} s`);

    // Hold PTT until shortly before the slot so the rig isn't keyed on dead air.
    const pttLeadMs = 250;
    const waitForPtt = targetTime - pttLeadMs - ft8Now();
    if (waitForPtt > 0) await wait(waitForPtt);
    if (ft8State.ft8TxQueuedMessage !== queued) return; // cancelled during the wait

    ft8State.ft8TxStatus = "PTT On";
    updateFt8TxUi();
    appendSerialLog(`[TX] PTT on`);
    await cat.setPtt(true);

    const waitMs = targetTime - ft8Now();
    if (waitMs > 0) await wait(waitMs);
    if (ft8State.ft8TxQueuedMessage !== queued) {
      await cat.setPtt(false);
      return;
    }

    ft8State.ft8TxStatus = "Transmitting";
    ft8State.ft8QsoStage = ft8StageForAction(queued.action, "sent");
    updateFt8TxUi();
    appendSerialLog(`[TX] Playing waveform`);
    await playFt8Waveform(encoded.waveform, encoded.sampleRate);
    appendSerialLog(`[TX] Waveform done, PTT off`);
    await cat.setPtt(false);

    ft8State.ft8LastTxText = queued.text;
    ft8State.ft8TxHistory.push({
      action: queued.action,
      text: queued.text,
      at: new Date().toISOString()
    });
    // RR73 (initiator's acknowledgement) and 73 (answerer's close) both complete
    // the QSO from our side: disarm (WSJT-X disable-Tx-after-73), then auto-log.
    if (queued.action === "73" || queued.action === "rrr") {
      setFt8TxEnabled(false, "QSO complete — Enable Tx off.");
      if (els.ft8AutoLog.checked) {
        logFt8Qso(true);
      } else {
        const qso = captureFt8QsoSnapshot();
        if (qso) {
          ft8State.ft8QsoStage = "Ready to continue";
          updateFt8TxUi();
          enqueueFt8LogConfirm(qso);
          appendSerialLog(`FT8 QSO complete with ${qso.callsign} — awaiting log confirmation.`);
        } else {
          appendSerialLog("FT8 QSO complete, but no DX callsign was staged — nothing to log.");
        }
      }
    }
    appendSerialLog(`FT8 transmitted: ${queued.text}`);
  } catch (error) {
    appendSerialLog(`FT8 transmit failed: ${error.message}`);
    try {
      await cat.setPtt(false);
    } catch {
      // Ignore cleanup failures while surfacing the original TX error.
    }
    ft8State.ft8TxStatus = "TX Error";
    // Stay armed — the watchdog bounds retries; the next slot tries again.
  } finally {
    // Only clean up if we still own the TX state: an abort (Halt Tx or a
    // selection override) clears/replaces ft8TxQueuedMessage and may already
    // be running a *new* dispatch whose state must not be clobbered.
    if (ft8State.ft8TxQueuedMessage === queued) {
      ft8State.ft8TxQueuedMessage = null;
      ft8State.ft8TxInProgress = false;
      if (ft8State.ft8TxStatus !== "TX Error") {
        ft8State.ft8TxStatus = ft8State.ft8TxEnabled ? "Armed" : "Idle";
      }
      updateFt8TxUi();
    }
  }
}

async function toggleFt8Tune() {
  if (ft8State.ft8TuneInProgress) {
    await stopFt8Tune();
  } else {
    await startFt8Tune();
  }
}

async function startFt8Tune() {
  if (ft8State.ft8TxEnabled) setFt8TxEnabled(false, "Tune started — Enable Tx off.");
  if (ft8State.ft8TxInProgress || ft8State.ft8TuneInProgress) return;
  const toneHz = clampFt8Tone(Number(els.ft8TxTone.value) || 1500);
  try {
    await ensureFt8TxAudioContext();
    const osc = ft8State.ft8TxAudioContext.createOscillator();
    osc.type = "sine";
    osc.frequency.value = toneHz;
    osc.connect(ft8State.ft8TxGainNode);
    osc.start();
    ft8State.ft8TuneOscillator = osc;
    ft8State.ft8TuneInProgress = true;
    ft8State.ft8TxStatus = "Tuning";
    updateFt8TxUi();
    await cat.setPtt(true);
    appendSerialLog(`[Tune] PTT on — ${toneHz} Hz carrier (auto-stop in 30 s)`);
    ft8State.ft8TuneTimerId = window.setTimeout(() => { void stopFt8Tune("Tune auto-stopped after 30 s."); }, 30000);
  } catch (error) {
    appendSerialLog(`Tune failed: ${error.message}`);
    await stopFt8Tune();
  }
}

async function stopFt8Tune(message = "") {
  if (ft8State.ft8TuneTimerId) {
    clearTimeout(ft8State.ft8TuneTimerId);
    ft8State.ft8TuneTimerId = null;
  }
  if (ft8State.ft8TuneOscillator) {
    try { ft8State.ft8TuneOscillator.stop(); } catch {}
    try { ft8State.ft8TuneOscillator.disconnect(); } catch {}
    ft8State.ft8TuneOscillator = null;
  }
  if (cat.getPtt()) {
    await cat.setPtt(false);
  }
  ft8State.ft8TuneInProgress = false;
  if (ft8State.ft8TxStatus === "Tuning") ft8State.ft8TxStatus = "Idle";
  updateFt8TxUi();
  appendSerialLog(message || "[Tune] PTT off, tune complete.");
}

async function abortFt8Transmission(message = "") {
  if (ft8State.ft8TxInProgress) {
    appendSerialLog(`[TX] Abort called while transmitting — mid-TX abort.`);
  }

  if (ft8State.ft8TxSourceNode) {
    try {
      ft8State.ft8TxSourceNode.stop();
    } catch {
      // Ignore stop races if the source already ended.
    }
    ft8State.ft8TxSourceNode = null;
  }

  ft8State.ft8TxQueuedMessage = null;
  ft8State.ft8TxInProgress = false;

  if (cat.getPtt()) {
    await cat.setPtt(false);
  }

  // A new dispatch may have started while we awaited PTT-off — don't clobber
  // its status; it owns the state machine now.
  if (!ft8State.ft8TxInProgress) {
    ft8State.ft8TxStatus = ft8State.ft8TxEnabled ? "Armed" : "Idle";
    updateFt8TxUi();
  }
  if (message) {
    appendSerialLog(message);
  }
}

function ft8StageForAction(action, stateLabel) {
  const map = {
    cq: { queued: "CQ queued", sent: "CQ sent" },
    reply: { queued: "Reply queued", sent: "Reply sent" },
    report: { queued: "Report queued", sent: "Report sent" },
    "r-report": { queued: "R-report queued", sent: "R-report sent" },
    rrr: { queued: "RR73 queued", sent: "RR73 sent" },
    "73": { queued: "73 queued", sent: "73 sent" }
  };

  return map[action]?.[stateLabel] || ft8State.ft8QsoStage;
}

// Builds the QSO object from the (already-synced) log form and clears DX/TX
// state for the next exchange, but does NOT commit it. Returns null if no DX
// callsign was staged — there's nothing to log. Shared by the immediate-commit
// path (logFt8Qso) and the log-confirm queue (enqueueFt8LogConfirm).
function captureFt8QsoSnapshot({ note = "" } = {}) {
  syncFt8ToLog();
  const notesField = document.querySelector("#notes");
  const historyText = ft8State.ft8TxHistory.map((entry) => entry.text).join(" | ");
  notesField.value = [notesField.value.trim(), historyText ? `FT8 TX: ${historyText}` : "", note]
    .filter(Boolean)
    .join(" ");
  // buildQsoFromForm's return value (and seedDateTime's side effect landing
  // before it) are needed synchronously here, so both go through
  // ctx.logger — see this file's header note.
  if (!appCtx?.logger?.buildQsoFromForm) return null; // Logger app (or ft8 mount) not ready
  appCtx.logger.seedDateTime();

  const qso = appCtx.logger.buildQsoFromForm();
  if (!qso.callsign) return null;

  ft8State.ft8TxHistory = [];
  ft8State.ft8TxParity = null;
  ft8State.ft8AutoSeq = false;
  // Clear the DX fields so the next QSO starts fresh (WSJT-X clearDX after a QSO).
  // MyCall/MyGrid are ours and stay; the report is recomputed from the next decode.
  els.ft8DxCall.value = "";
  els.ft8DxGrid.value = "";
  els.ft8ReceivedReport.value = "";
  els.ft8SentReport.value = "";
  updateFt8TxUi();
  return qso;
}

function logFt8Qso(isAuto = false) {
  const qso = captureFt8QsoSnapshot({ note: isAuto ? "Auto-logged after 73." : "" });
  if (!qso) {
    appendSerialLog("Enter or stage a DX callsign before logging the FT8 QSO.");
    return;
  }

  logbook.commit(qso);
  ft8State.ft8WorkedCallsigns.add(qso.callsign.toUpperCase());
  ft8State.ft8QsoStage = isAuto ? "Logged" : "Ready to continue";
  if (isAuto) {
    ft8State.ft8LastTxText = "Logged after 73";
  }
  updateFt8TxUi();
  appendSerialLog(`FT8 QSO logged${isAuto ? " automatically" : ""} for ${qso.callsign}.`);
}

// Push a captured QSO snapshot onto the confirm queue. If it's the only item,
// show its popup now; otherwise it waits its turn (FIFO, one popup at a time).
function enqueueFt8LogConfirm(qso) {
  ft8State.ft8LogQueue.push(qso);
  if (ft8State.ft8LogQueue.length === 1) renderFt8LogConfirmPopup();
}

// Show the popup for the current queue head (ft8State.ft8LogQueue[0]).
function renderFt8LogConfirmPopup() {
  const qso = ft8State.ft8LogQueue[0];
  if (!qso || !els.ft8LogConfirm) return;
  els.ft8LogConfirmCallsign.textContent = qso.callsign;
  els.ft8LogConfirmOperator.textContent = qso.operatorName || "";
  els.ft8LogConfirmTime.textContent = qso.time ? `${qso.time.replace(":", "")}Z` : "--";
  els.ft8LogConfirmGrid.textContent = qso.gridSquare || "--";
  els.ft8LogConfirmBandMode.textContent = [qso.band, qso.mode].filter(Boolean).join(" · ") || "--";
  els.ft8LogConfirmRst.textContent = qso.rstSent || qso.rstReceived ? `${qso.rstSent || "--"} / ${qso.rstReceived || "--"}` : "--";
  els.ft8LogConfirmFrequency.textContent = qso.frequency || "--";
  els.ft8LogConfirm.hidden = false;
}

// Resolve the queue head: "log" commits it, "skip" discards it. Either way,
// advance to the next queued item or hide the popup if none remain.
function resolveFt8LogConfirm(action) {
  const qso = ft8State.ft8LogQueue.shift();
  if (!qso) return;
  if (action === "log") {
    logbook.commit(qso);
    ft8State.ft8WorkedCallsigns.add(qso.callsign.toUpperCase());
    appendSerialLog(`FT8 QSO logged for ${qso.callsign} (confirmed).`);
  } else {
    appendSerialLog(`FT8 QSO with ${qso.callsign} skipped (not logged).`);
  }
  if (ft8State.ft8LogQueue.length > 0) {
    renderFt8LogConfirmPopup();
  } else if (els.ft8LogConfirm) {
    els.ft8LogConfirm.hidden = true;
  }
}

function renderFt8Messages() {
  const messages = buildFt8Messages();

  if (!els.ft8MessageList) return;
  els.ft8MessageList.innerHTML = messages
    .map(
      (message) => `
        <div class="ft8-message">
          <div class="ft8-message-header">
            <strong>${escapeHtml(message.title)}</strong>
            <span class="ft8-meta">${escapeHtml(message.meta)}</span>
          </div>
          <code>${escapeHtml(message.text)}</code>
          ${
            message.action
              ? `<div class="ft8-action-row"><button type="button" class="secondary" data-ft8-message-action="${message.action}">Queue</button></div>`
              : ""
          }
        </div>
      `
    )
    .join("");
}

function buildFt8Messages() {
  const myCall = normalizeToken(els.ft8MyCall.value);
  // Standard FT8 messages carry only a 4-character grid; truncate any 6-char
  // locator so the transmitted message stays protocol-legal.
  const myGrid = normalizeToken(els.ft8MyGrid.value).slice(0, 4);
  const dxCall = normalizeToken(els.ft8DxCall.value);
  const dxGrid = normalizeToken(els.ft8DxGrid.value);
  const sent = normalizeReport(els.ft8SentReport.value);
  const received = normalizeReport(els.ft8ReceivedReport.value);

  return [
    {
      action: "cq",
      title: "CQ",
      meta: "General CQ message",
      text: [myCall ? `CQ ${myCall}` : "CQ YOURCALL", myGrid || "YOURGRID"].join(" ")
    },
    {
      action: "reply",
      title: "Answer CQ",
      meta: "Call the station and send your grid",
      text: [dxCall || "DXCALL", myCall || "MYCALL", myGrid || "MYGRID"].join(" ")
    },
    {
      action: "report",
      title: "Send Report",
      meta: "Standard FT8 signal report",
      text: [dxCall || "DXCALL", myCall || "MYCALL", sent || "-10"].join(" ")
    },
    {
      action: "r-report",
      title: "Confirm + Report",
      meta: "Acknowledge their report and send yours",
      text: [dxCall || "DXCALL", myCall || "MYCALL", `R${sent || "-10"}`].join(" ")
    },
    {
      action: "rrr",
      title: "Send RR73",
      meta: "Roger received report + 73 (WSJT-X default acknowledgement)",
      text: [dxCall || "DXCALL", myCall || "MYCALL", "RR73"].join(" ")
    },
    {
      action: "73",
      title: "Send 73",
      meta: "Close the contact",
      text: [dxCall || "DXCALL", myCall || "MYCALL", "73"].join(" ")
    },
    {
      title: "Expected Reply",
      meta: "What you expect back from the other station",
      text: [myCall || "MYCALL", dxCall || "DXCALL", received || "-12"].join(" ")
    },
    {
      title: "Expected Signoff",
      meta: "Typical close after your RR73",
      text: [myCall || "MYCALL", dxCall || "DXCALL", "73"].join(" ")
    },
    {
      title: "DX Grid Reference",
      meta: "Known grid square for the target station",
      text: dxGrid || "DXGRID"
    }
  ];
}

export function renderFt8TextDecodes() {
  if (!els.ft8TextDecodes) return;

  const activeFilter = els.ft8DecodesFilterEl
    ? (els.ft8DecodesFilterEl.querySelector("button.active")?.dataset.ft8Filter || "all")
    : "all";
  const search = (els.ft8DecodesSearch?.value || "").trim().toUpperCase();

  // Flatten decode history (last 10 slots), newest first
  const allSlots = ft8State.ft8DecodeHistory.slice().reverse();

  if (!allSlots.length) {
    els.ft8TextDecodes.innerHTML =
      '<div class="empty-state">No FT8 decodes yet. Start the FT8 session and let a full 15-second frame buffer build.</div>';
    return;
  }

  const myCall = normalizeToken(els.ft8MyCall?.value || "");
  const rows = [];
  for (const { slotMs, messages } of allSlots) {
    const filtered = messages.filter(msg => {
      if (search && !(msg.text || "").toUpperCase().includes(search)) return false;
      if (activeFilter === "cq") return /\bCQ\b/i.test(msg.text);
      if (activeFilter === "unworked") {
        // Match the W badge: the station's call is tokens[1] on a CQ, else tokens[0].
        const tokens = (msg.text || "").split(/\s+/);
        const call = (/\bCQ\b/i.test(msg.text) ? tokens[1] : tokens[0]) || "";
        return !ft8State.ft8WorkedCallsigns.has(call.toUpperCase());
      }
      return true;
    });
    if (!filtered.length) continue;

    const slotSec = Math.floor(slotMs / 1000);
    const hh = String(Math.floor(slotSec / 3600) % 24).padStart(2, "0");
    const mm = String(Math.floor(slotSec / 60) % 60).padStart(2, "0");
    const ss = String(slotSec % 60).padStart(2, "0");
    rows.push(`<div class="ft8-slot-divider">${hh}:${mm}:${ss} UTC</div>`);

    for (const message of filtered) {
      const isCq = /\bCQ\b/i.test(message.text);
      const db = typeof message.db === "number" ? message.db : parseFloat(message.db) || 0;
      const snrClass = db >= -5 ? "dec-snr pos" : db >= -15 ? "dec-snr neg" : "dec-snr weak";
      const snrText = db > 0 ? `+${db}` : String(db);
      const dfHz = Math.round(message.df || 0);
      const dtSec = Math.round(message.dt || 0);
      const timeLabel = `:${String((slotSec + dtSec) % 60).padStart(2, "0")}`;

      // Worked-before badge
      const tokens = (message.text || "").split(/\s+/);
      const decodedCall = (isCq ? tokens[1] : tokens[0]) || "";
      const isWorked = decodedCall && ft8State.ft8WorkedCallsigns.has(decodedCall.toUpperCase());

      const msgHtml = escapeHtml(message.text).replace(
        /\b([A-Z0-9]{3,}[0-9][A-Z0-9]{0,3})\b/g,
        '<span class="cs">$1</span>'
      );
      // Station responding to us: standard FT8 is "TO FROM payload", so a decode
      // whose TO field is our own call is someone calling/answering us. Most
      // important row in auto-seq, so flag it (overrides the worked dimming).
      const toField = normalizeToken((tokens[0] || "").replace(/[<>]/g, ""));
      const toMe = !!myCall && !isCq && toField === myCall;
      const workedBadge = isWorked ? '<span class="dec-worked" title="Already in log">W</span>' : "";
      const rowClass = ["ft8-decode-row",
        isCq ? "cq" : "",
        message.newGrid ? "new-grid" : "",
        isWorked ? "worked" : "",
        toMe ? "to-me" : ""].filter(Boolean).join(" ");
      rows.push(`<div class="${rowClass}"
          data-ft8-decode-action="use"
          data-ft8-decode-text="${escapeHtml(message.text)}"
          data-db="${db}"
          data-slot-ms="${slotMs}">
          <span class="dec-time">${timeLabel}</span>
          <span class="${snrClass}">${snrText}</span>
          <span class="dec-freq">${dfHz}</span>
          <div class="dec-msg">${msgHtml}${workedBadge}</div>
          <button class="dec-reply" type="button"
            data-ft8-decode-action="reply"
            data-ft8-decode-text="${escapeHtml(message.text)}">Reply</button>
        </div>`);
    }
  }

  if (!rows.length) {
    els.ft8TextDecodes.innerHTML = '<div class="empty-state">No decodes match this filter.</div>';
    return;
  }
  els.ft8TextDecodes.innerHTML = rows.join("");
}

function handleFt8DecodeFilter(event) {
  const btn = event.target.closest("[data-ft8-filter]");
  if (!btn || !els.ft8DecodesFilterEl) return;
  els.ft8DecodesFilterEl.querySelectorAll("button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderFt8TextDecodes();
}

// Stage of a decode directed at us → the message that answers it. Mirrors the
// ladder in advanceFt8AutoSeq so the manual Reply button advances the exchange.
// "CQ copied"/"73 copied"/unknown are absent on purpose (handled by the caller's
// grid/report fallback).
const FT8_STAGE_REPLY = {
  "Grid copied": "report",
  "Report copied": "r-report",
  "R-report copied": "rrr",
  "RRR copied": "73",
  "RR73 copied": "73",
};

function handleFt8DecodeAction(event) {
  const button = event.target.closest("[data-ft8-decode-action]");
  if (!button) {
    return;
  }

  const text = button.dataset.ft8DecodeText || "";
  const rowEl = button.closest(".ft8-decode-row");
  const slotMs = Number(rowEl?.dataset.slotMs || 0) || ft8Now();
  const snrDb = rowEl?.dataset.db !== undefined ? Number(rowEl.dataset.db) : undefined;
  applyFt8DecodeToForm(text, slotMs, snrDb);

  // Update RX marker from the clicked row's freq column
  const row = button.closest(".ft8-decode-row");
  if (row && els.ft8WfRxMarker) {
    const freqEl = row.querySelector(".dec-freq");
    const dfHz = freqEl ? parseInt(freqEl.textContent, 10) : 0;
    if (dfHz > 0) {
      const pct = ((dfHz - 200) / (3000 - 200)) * 100;
      els.ft8WfRxMarker.style.left = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
      els.ft8WfRxMarker.dataset.label = `RX ${dfHz}`;
      if (els.whDisplayRxFreq) els.whDisplayRxFreq.value = String(dfHz);
    }
  }

  if (button.dataset.ft8DecodeAction === "reply") {
    // Pick the next message from what the station actually sent (WSJT-X: a click
    // on a directed message generates the correct reply), so clicking a station
    // that answered you advances the QSO instead of re-sending your grid. CQ (and
    // unparseable rows) fall back to the grid reply, or the report if Skip Tx1.
    const stage = parseFt8DecodeText(text)?.stage;
    const action = FT8_STAGE_REPLY[stage] || (els.ft8SkipTx1?.checked ? "report" : "reply");
    selectFt8Message(action);
    // WSJT-X default "double-click on call sets Tx enable": one click starts the QSO.
    setFt8TxEnabled(true, "Enable Tx ON — replying at the next matching slot.");
    // Turn on auto-sequencing too so the rest of the exchange runs hands-off.
    if (!ft8State.ft8AutoSeq) {
      ft8State.ft8AutoSeq = true;
      ft8State.ft8AutoSeqDeadline = ft8Now() + FT8_AUTOSEQ_WATCHDOG_MS;
      updateFt8AutoSeqUi();
      appendSerialLog("FT8 auto-sequencing enabled (Reply).");
    }
  }
}

function handleFt8MessageAction(event) {
  const button = event.target.closest("[data-ft8-message-action]");
  if (!button) {
    return;
  }

  selectFt8Message(button.dataset.ft8MessageAction);
}

export function applyFt8DecodeToForm(text, slotMs, snrDb) {
  const decoded = parseFt8DecodeText(text);
  if (!decoded) {
    appendSerialLog("That decode could not be turned into a guided FT8 contact step.");
    return;
  }

  if (decoded.dxCall) {
    els.ft8DxCall.value = decoded.dxCall;
  }
  if (decoded.dxGrid) {
    els.ft8DxGrid.value = decoded.dxGrid;
  }
  if (decoded.receivedReport) {
    els.ft8ReceivedReport.value = decoded.receivedReport;
  }
  // Report the DX at the SNR we actually copied them at (WSJT-X behaviour),
  // rather than a static default.
  const sentReport = formatFt8Report(snrDb);
  if (sentReport) {
    els.ft8SentReport.value = sentReport;
  }
  if (decoded.stage) {
    ft8State.ft8QsoStage = decoded.stage;
  }

  // Set TX parity opposite to the slot the CQ/reply was *transmitted* in.
  // The decode fires at the start of slot N+1 (slotMs = start of N+1), but the
  // message was transmitted in slot N, so subtract 1 to get the correct slot.
  if (decoded.stage === "CQ copied" || decoded.stage === "Grid copied") {
    const rxSlot = Math.floor((slotMs || ft8Now()) / 15000) - 1;
    ft8State.ft8TxParity = rxSlot % 2 === 0 ? "odd" : "even";
  }

  renderFt8Messages();
  updateFt8TxUi();
  appendSerialLog(`Staged FT8 decode: ${decoded.summary}`);
}

export default {
  id: "ft8",
  title: "FT8",
  // This app's top-level functions aren't nested inside mount() (unlike
  // logger/radio's fully nested style), so they can't close over a
  // destructured ctx the way those apps do — they import the connector
  // singletons directly by path instead (cat/audio/logbook/bus above),
  // which resolve to the exact same instances ctx would carry. ctx itself
  // is still needed here for two cross-app seams (ctx.ft8, ctx.logger), so
  // mount() stashes it in the module-scope `appCtx` above and installs
  // ctx.ft8 as its very first statement — before any DOM binding below —
  // so it's live as early as possible for map/radio to read.
  mount(panelEl, ctx) {
    appCtx = ctx;
    ctx.ft8 = {
      get sessionRunning() { return isFt8SessionRunning(); },
      get decodeHistory() { return ft8State.ft8DecodeHistory; },
      get workedCallsigns() { return ft8State.ft8WorkedCallsigns; },
      get txInProgress() { return ft8State.ft8TxInProgress; },
      pruneDecodeTimestamps(cutoffMs) {
        ft8State.ft8DecodeTimestamps = ft8State.ft8DecodeTimestamps.filter((t) => t > cutoffMs);
        return ft8State.ft8DecodeTimestamps.length;
      },
    };

    Object.assign(els, {
      ft8MyCall: document.querySelector("#ft8-my-call"),
      ft8MyGrid: document.querySelector("#ft8-my-grid"),
      ft8DxCall: panelEl.querySelector("#ft8-dx-call"),
      ft8DxGrid: panelEl.querySelector("#ft8-dx-grid"),
      ft8SentReport: panelEl.querySelector("#ft8-sent-report"),
      ft8ReceivedReport: panelEl.querySelector("#ft8-received-report"),
      ft8FillFrequencyBtn: panelEl.querySelector("#ft8-fill-frequency-btn"),
      ft8SyncLogBtn: panelEl.querySelector("#ft8-sync-log-btn"),
      ft8StartSessionBtn: panelEl.querySelector("#ft8-start-session-btn"),
      ft8StopSessionBtn: panelEl.querySelector("#ft8-stop-session-btn"),
      ft8SlotLabel: panelEl.querySelector("#ft8-slot-label"),
      ft8Countdown: panelEl.querySelector("#ft8-countdown"),
      ft8SessionNotes: panelEl.querySelector("#ft8-session-notes"),
      ft8MessageList: panelEl.querySelector("#ft8-message-list"),
      ft8TxStatus: panelEl.querySelector("#ft8-tx-status"),
      ft8QsoStage: panelEl.querySelector("#ft8-qso-stage"),
      ft8NextTx: panelEl.querySelector("#ft8-next-tx"),
      ft8TxTone: panelEl.querySelector("#ft8-tx-tone"),
      ft8TxToneReadout: panelEl.querySelector("#ft8-tx-tone-readout"),
      ft8LastTx: panelEl.querySelector("#ft8-last-tx"),
      ft8AutoLog: panelEl.querySelector("#ft8-auto-log"),
      ft8AutoLogStatus: panelEl.querySelector("#ft8-auto-log-status"),
      ft8LogConfirm: panelEl.querySelector("#ft8-log-confirm"),
      ft8LogConfirmCallsign: panelEl.querySelector("#ft8-log-confirm-callsign"),
      ft8LogConfirmOperator: panelEl.querySelector("#ft8-log-confirm-operator"),
      ft8LogConfirmTime: panelEl.querySelector("#ft8-log-confirm-time"),
      ft8LogConfirmGrid: panelEl.querySelector("#ft8-log-confirm-grid"),
      ft8LogConfirmBandMode: panelEl.querySelector("#ft8-log-confirm-band-mode"),
      ft8LogConfirmRst: panelEl.querySelector("#ft8-log-confirm-rst"),
      ft8LogConfirmFrequency: panelEl.querySelector("#ft8-log-confirm-frequency"),
      ft8LogConfirmLogBtn: panelEl.querySelector("#ft8-log-confirm-log-btn"),
      ft8LogConfirmSkipBtn: panelEl.querySelector("#ft8-log-confirm-skip-btn"),
      ft8QueueCqBtn: panelEl.querySelector("#ft8-queue-cq-btn"),
      ft8QueueReplyBtn: panelEl.querySelector("#ft8-queue-reply-btn"),
      ft8QueueReportBtn: panelEl.querySelector("#ft8-queue-report-btn"),
      ft8QueueRrrBtn: panelEl.querySelector("#ft8-queue-rrr-btn"),
      ft8Queue73Btn: panelEl.querySelector("#ft8-queue-73-btn"),
      ft8AbortTxBtn: panelEl.querySelector("#ft8-abort-tx-btn"),
      ft8EnableTxBtn: panelEl.querySelector("#ft8-enable-tx-btn"),
      ft8FreeText: panelEl.querySelector("#ft8-freetext"),
      ft8FreeTextBtn: panelEl.querySelector("#ft8-freetext-btn"),
      ft8TxParityBtn: panelEl.querySelector("#ft8-tx-parity-btn"),
      ft8SkipTx1: panelEl.querySelector("#ft8-skip-tx1"),
      ft8TuneBtn: panelEl.querySelector("#ft8-tune-btn"),
      ft8LogQsoBtn: panelEl.querySelector("#ft8-log-qso-btn"),
      ft8DecodeNowBtn: panelEl.querySelector("#ft8-decode-now-btn"),
      ft8AudioDevice: panelEl.querySelector("#ft8-audio-device"),
      ft8AudioOutput: panelEl.querySelector("#ft8-audio-output"),
      ft8FftSize: panelEl.querySelector("#ft8-fft-size"),
      ft8DecoderStatus: panelEl.querySelector("#ft8-decoder-status"),
      ft8Waterfall: panelEl.querySelector("#ft8-waterfall"),
      ft8TextDecodes: panelEl.querySelector("#ft8-text-decodes"),
      ft8DecoderList: panelEl.querySelector("#ft8-decoder-list"),
      ft8SlotRingFill: panelEl.querySelector("#ft8-slot-ring-fill"),
      ft8SlotParity: panelEl.querySelector("#ft8-slot-parity"),
      ft8TxCard: panelEl.querySelector("#ft8-tx-card"),
      ft8TargetCall: panelEl.querySelector("#ft8-target-call"),
      ft8TargetMeta: panelEl.querySelector("#ft8-target-meta"),
      ft8NextMsg: panelEl.querySelector("#ft8-next-msg"),
      ft8DecodesRate: panelEl.querySelector("#ft8-decodes-rate"),
      ft8FreqMhz: panelEl.querySelector("#ft8-freq-mhz"),
      ft8FreqBand: panelEl.querySelector("#ft8-freq-band"),
      ft8WfRxMarker: panelEl.querySelector("#ft8-wf-rx-marker"),
      ft8WfTxMarker: panelEl.querySelector("#ft8-wf-tx-marker"),
      ft8WfFftLabel: panelEl.querySelector("#ft8-wf-fft-label"),
      ft8QsoStripEl: panelEl.querySelector("#ft8-qso-strip"),
      ft8DecodesFilterEl: panelEl.querySelector("#ft8-decodes-filter"),
      ft8DecodesSearch: panelEl.querySelector("#ft8-decodes-search"),
      whDisplayRxFreq: panelEl.querySelector("#wh-display-rx-freq"),
      whDisplayTxFreq: panelEl.querySelector("#wh-display-tx-freq"),
      whSpectrumFftLabel: panelEl.querySelector("#wh-spectrum-fft-label"),
      ft8MeterFill: panelEl.querySelector("#ft8-meter-fill"),
      ft8NoiseFloor: panelEl.querySelector("#ft8-noise-floor"),
      ft8PeakTone: panelEl.querySelector("#ft8-peak-tone"),
      ft8Activity: panelEl.querySelector("#ft8-activity"),
      ft8FrameBuffer: panelEl.querySelector("#ft8-frame-buffer"),
      ft8SyncQuality: panelEl.querySelector("#ft8-sync-quality"),
      ft8LastFrame: panelEl.querySelector("#ft8-last-frame"),
      ft8SymbolStream: panelEl.querySelector("#ft8-symbol-stream"),
      ft8PayloadBits: panelEl.querySelector("#ft8-payload-bits"),
      ft8ChannelBits: panelEl.querySelector("#ft8-channel-bits"),
    });

    // guard that suspends frequency polling during FT8 TX/tune. Reads
    // ft8State directly now (same module) instead of through
    // ctx.ft8, which existed only so other apps (map/radio) could reach
    // these two fields.
    cat.setPollGuard(() => ft8State.ft8TxInProgress || ft8State.ft8TuneInProgress);

    // Review fix: restores main's (the old monolith b8a4189) updateRadioUi()-owned half
    // of the TX-blank — the "ft8-wf-tx-blank" class + peak/noise-floor/
    // activity readouts — by driving it off the cat "ptt" event instead of
    // audio.js's drawWaterfall rAF loop, so it fires (and clears) on every
    // PTT change app-wide, independent of whether the FT8 audio monitor is
    // running. See audio.js's setTxBlank() and its header note for the full
    // two-source design this restores. `cat` here is the same connector
    // instance ctx.cat carries — see this file's top-of-file note on why
    // top-level code imports it directly instead of destructuring ctx.
    cat.addEventListener("ptt", (e) => setTxBlank(e.detail));
    setTxBlank(cat.getPtt());

    const safeBind = (el, event, handler) => {
      if (el) el.addEventListener(event, handler);
    };

    safeBind(els.ft8Waterfall, "click", handleWaterfallClick);
    safeBind(els.ft8Waterfall, "contextmenu", handleWaterfallClick);
    safeBind(els.ft8FillFrequencyBtn, "click", applyFt8Defaults);
    safeBind(els.ft8SyncLogBtn, "click", syncFt8ToLog);
    safeBind(els.ft8StartSessionBtn, "click", startFt8Session);
    safeBind(els.ft8StopSessionBtn, "click", stopFt8Session);
    safeBind(els.ft8QueueCqBtn, "click", () => { selectFt8Message("cq"); });
    safeBind(els.ft8QueueReplyBtn, "click", () => { selectFt8Message("reply"); });
    safeBind(els.ft8QueueReportBtn, "click", () => { selectFt8Message("report"); });
    safeBind(els.ft8QueueRrrBtn, "click", () => { selectFt8Message("rrr"); });
    safeBind(els.ft8Queue73Btn, "click", () => { selectFt8Message("73"); });
    safeBind(els.ft8AbortTxBtn, "click", () => {
      // Halt: stop the current TX and clear the selected exchange, but leave Enable
      // Tx armed so nothing transmits (scheduler skips with no selection) until you
      // pick a new message. Auto-seq goes off too, else the next decode re-selects.
      ft8State.ft8SelectedAction = null;
      ft8State.ft8LastDispatchedSlot = -1;
      if (ft8State.ft8AutoSeq) {
        ft8State.ft8AutoSeq = false;
        updateFt8AutoSeqUi();
      }
      void abortFt8Transmission("FT8 Tx halted — exchange cleared, Enable Tx still armed.");
      updateFt8TxUi();
    });
    safeBind(els.ft8EnableTxBtn, "click", () => { setFt8TxEnabled(!ft8State.ft8TxEnabled); });
    safeBind(els.ft8FreeTextBtn, "click", () => { selectFt8Message("freetext"); });
    safeBind(els.ft8FreeText, "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); selectFt8Message("freetext"); } });
    safeBind(els.ft8TxParityBtn, "click", () => { cycleFt8TxParity(); });
    safeBind(els.ft8SkipTx1, "change", () => {
      appendSerialLog(`FT8 Skip Tx1 ${els.ft8SkipTx1.checked ? "ON — answering a CQ sends a report (no grid)" : "OFF — answering a CQ sends your grid first"}.`);
    });
    safeBind(els.ft8TuneBtn, "click", () => { void toggleFt8Tune(); });
    let lastBandClick = { band: null, at: 0 };
    let tuneHintBtn = null, tuneHintTimer = null;
    const restoreBandLabel = () => {
      if (tuneHintTimer) { clearTimeout(tuneHintTimer); tuneHintTimer = null; }
      if (tuneHintBtn) { tuneHintBtn.textContent = tuneHintBtn.dataset.bandLabel; tuneHintBtn = null; }
    };
    safeBind(panelEl.querySelector("#ft8-band-row"), "click", (e) => {
      const btn = e.target.closest("[data-ft8-band]");
      const band = btn?.dataset.ft8Band;
      const hz = band && FT8_BAND_FREQUENCIES[band];
      if (!hz) return;
      const now = Date.now();
      // First click QSYs to the band; a second click on the same band within the
      // window fires Tune (toggle) instead of re-tuning the radio.
      if (band === lastBandClick.band && now - lastBandClick.at < 700) {
        lastBandClick = { band: null, at: 0 };
        restoreBandLabel();
        void toggleFt8Tune();
      } else {
        void cat.setFrequency(hz);
        lastBandClick = { band, at: now };
        // Briefly relabel the button "Tune" to hint that a second click tunes.
        restoreBandLabel();
        btn.dataset.bandLabel = btn.textContent;
        btn.textContent = "Tune";
        tuneHintBtn = btn;
        tuneHintTimer = setTimeout(restoreBandLabel, 700);
      }
    });
    safeBind(els.ft8LogQsoBtn, "click", () => { logFt8Qso(); });
    safeBind(els.ft8DecodeNowBtn, "click", () => { void runFt8Decode(false); });
    safeBind(panelEl.querySelector("#ft8-auto-seq-btn"), "click", () => {
      ft8State.ft8AutoSeq = !ft8State.ft8AutoSeq;
      if (ft8State.ft8AutoSeq) ft8State.ft8AutoSeqDeadline = ft8Now() + FT8_AUTOSEQ_WATCHDOG_MS;
      updateFt8AutoSeqUi();
      appendSerialLog(`FT8 auto-sequencing ${ft8State.ft8AutoSeq ? "enabled" : "disabled"}.`);
    });
    safeBind(els.ft8TextDecodes, "click", handleFt8DecodeAction);
    safeBind(els.ft8MessageList, "click", handleFt8MessageAction);
    safeBind(els.ft8TxTone, "input", updateFt8TxUi);
    safeBind(els.ft8AutoLog, "change", updateFt8TxUi);
    safeBind(els.ft8LogConfirmLogBtn, "click", () => { resolveFt8LogConfirm("log"); });
    safeBind(els.ft8LogConfirmSkipBtn, "click", () => { resolveFt8LogConfirm("skip"); });
    safeBind(els.ft8DecodesFilterEl, "click", handleFt8DecodeFilter);
    safeBind(els.ft8DecodesSearch, "input", renderFt8TextDecodes);
    // Advanced toggle button (open/close the details panel)
    const ft8AdvancedToggle = panelEl.querySelector("#ft8-advanced-toggle");
    if (ft8AdvancedToggle) {
      const ft8AdvancedDetails = panelEl.querySelector("#ft8-advanced-details");
      ft8AdvancedToggle.addEventListener("click", () => {
        if (ft8AdvancedDetails) {
          ft8AdvancedDetails.open = !ft8AdvancedDetails.open;
          ft8AdvancedToggle.textContent = ft8AdvancedDetails.open ? "Advanced ▴" : "Advanced ▾";
        }
      });
    }
    safeBind(els.ft8AudioOutput, "change", (e) => {
      audio.getConfig().perApp.ft8.output = e.target.value;
      audio.saveDeviceConfig();
      void applyFt8TxOutputDevice();
    });
    safeBind(els.ft8AudioDevice, "change", (e) => {
      audio.getConfig().perApp.ft8.input = e.target.value;
      audio.saveDeviceConfig();
    });
    safeBind(els.ft8FftSize, "change", updateFftLabel);
    updateFftLabel();
    // a settings-tab
    // field edit needs to refresh the FT8 message preview, but settings
    // fields live outside #tab-ft8 and this module can't call
    // renderFt8Messages/updateFt8TxUi directly — js/apps/settings/index.js's
    // own mount() dispatches
    // bus "ft8-preview-refresh" for the same input/change bindings it always
    // had on those fields (settingsQrzUser/HamqthUser/StationCall/Theme);
    // this is the listener side.
    bus.addEventListener("ft8-preview-refresh", () => { renderFt8Messages(); updateFt8TxUi(); });
    [
      els.ft8MyCall,
      els.ft8MyGrid,
      els.ft8DxCall,
      els.ft8DxGrid,
      els.ft8SentReport,
      els.ft8ReceivedReport,
    ].forEach((element) => safeBind(element, "input", () => { renderFt8Messages(); updateFt8TxUi(); }));
    // Same 6 fields bound to "input" a second time in the monolith's original code
    // (a pre-existing duplicate binding, not introduced by this move) —
    // preserved byte-for-byte rather than deduplicated.
    [
      els.ft8MyCall, els.ft8MyGrid, els.ft8DxCall,
      els.ft8DxGrid, els.ft8SentReport, els.ft8ReceivedReport
    ].forEach((element) => {
      safeBind(element, "input", () => {
        renderFt8Messages();
        updateFt8TxUi();
      });
    });

    // js/apps/radio/index.js dispatches this for highlightFt8BandRow, which
    // it can no longer call directly.
    bus.addEventListener("frequency-display-updated", (e) => highlightFt8BandRow(e.detail));

    // js/shell/shell.js's applyAudioDeviceConfig() re-routes the FT8 TX audio
    // context whenever a global/per-app output device changes. Was
    // `window.applyFt8TxOutputDeviceSync`; now hung off the ctx.ft8 capability
    // this app already publishes, so the shell has one documented way to reach
    // into a mini-app instead of two (ctx for some things, window for others).
    ctx.ft8.applyTxOutputDevice = () => { void applyFt8TxOutputDevice(); };

    // Boot-time UI seed — was the monolith's init() FT8 block, moved here per the
    // brief ("preserve boot behavior via mount()"); main.js mounts every app
    // synchronously right after `import "../the old monolith"` evaluates, matching the
    // reordering-is-safe reasoning every earlier mini-app task used for its
    // own boot-call move.
    renderFt8Messages();
    renderDecoderCandidates();
    renderFt8TextDecodes();
    updateFrameCaptureUi();
    updateFt8TxUi();
    updateFt8Clock();
    clearWaterfall();

    void initializeFt8Decoder().catch((e) => console.warn("FT8 decoder init failed", e));
  }
};
