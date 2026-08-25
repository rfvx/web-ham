// FT8 mini-app — the RX audio monitor (getUserMedia capture, waterfall
// canvas, analyser) and the TX audio graph (encoder waveform playback
// through a dedicated AudioContext routed to the chosen output device).
//
// Firefox constraint (preserved byte-for-byte from the old monolith): startFt8AudioMonitor
// calls stopFt8AudioMonitor() and reads the FT8 input device BEFORE awaiting
// getUserMedia — no network request (e.g. the clock-sync fetch in
// startFt8Session, ./index.js) is awaited ahead of getUserMedia, because a
// failed fetch first causes Firefox to reject the mic prompt.
//
// Cross-file seams (circular import with ./index.js, safe — see that file's
// header note): shares `ft8State`, calls index.js's `appendSerialLog` (thin
// bus dispatcher), `renderFt8TextDecodes` (decode-list UI, called from
// stopFt8AudioMonitor's reset tail) and `updateFt8TxUi` (called from
// handleWaterfallClick's right-click-sets-TX-tone branch). Also imports
// decode.js's `renderDecoderCandidates`/`updateFrameCaptureUi` (reset tail)
// and `analyzeFt8Frames`/`updateExperimentalDecoder` (per-audio-frame decode
// hooks) — none of these are read at module-evaluation time, only inside
// functions called after mount(), so the circular references resolve fine.
//
// TX-blank (ported from main b8a4189; review fix restores main's two-source
// design — see js/apps/ft8/index.js's mount() note on the cat "ptt"
// listener): main blanked from TWO independent places — updateRadioUi()
// (app-wide, fires on every PTT change regardless of whether the FT8
// monitor is running) owned the "ft8-wf-tx-blank" class + the peak/
// noise-floor/activity readout text, while drawWaterfall's renderFrame
// separately painted the blank waterfall row + pinned the meter. A first
// pass at this port collapsed both into a single per-frame cat.getPtt()
// poll here, which meant the class/readouts only cleared while the rAF
// loop was alive — stuck blanked if the loop stopped (session stopped, or
// audio monitor never started) while still keyed. setTxBlank() below is now
// the class+readouts owner (called from index.js's cat "ptt" listener, so
// it fires and clears independent of this loop); renderFrame here still
// reads cat.getPtt() live every frame but only for what's inherently tied
// to the loop: the blank waterfall row + the meter pin.
import { audio } from "../../connectors/audio.js";
import { cat } from "../../connectors/cat.js";
import { ft8State, appendSerialLog, renderFt8TextDecodes, updateFt8TxUi } from "./index.js";
import {
  renderDecoderCandidates, updateFrameCaptureUi, analyzeFt8Frames, updateExperimentalDecoder,
} from "./decode.js";

// NOTE: like decode.js, these resolve at module-eval (import) time rather than
// in mount() — the deliberate exception to the els-in-mount() pattern. Safe
// because #tab-ft8 and its #ft8-* children exist in index.html's static markup
// and the shell moves (not recreates) panels. See decode.js for the full note.
const els = {
  ft8AudioStatus: document.querySelector("#ft8-audio-status"),
  ft8DecoderStatus: document.querySelector("#ft8-decoder-status"),
  ft8FftSize: document.querySelector("#ft8-fft-size"),
  ft8Activity: document.querySelector("#ft8-activity"),
  ft8ChannelBits: document.querySelector("#ft8-channel-bits"),
  ft8MeterFill: document.querySelector("#ft8-meter-fill"),
  ft8NoiseFloor: document.querySelector("#ft8-noise-floor"),
  ft8PayloadBits: document.querySelector("#ft8-payload-bits"),
  ft8PeakTone: document.querySelector("#ft8-peak-tone"),
  ft8SymbolStream: document.querySelector("#ft8-symbol-stream"),
  ft8Waterfall: document.querySelector("#ft8-waterfall"),
  ft8WfPanel: document.querySelector(".ft8-wf-panel"),
  ft8TxTone: document.querySelector("#ft8-tx-tone"),
  ft8WfRxMarker: document.querySelector("#ft8-wf-rx-marker"),
  whDisplayRxFreq: document.querySelector("#wh-display-rx-freq"),
};

export async function startFt8AudioMonitor() {
  if (!navigator.mediaDevices) {
    els.ft8AudioStatus.textContent = "No Media API";
    appendSerialLog("This browser does not expose the media capture APIs needed for the FT8 monitor.");
    return;
  }

  try {
    await stopFt8AudioMonitor();

    const deviceId = audio.inputFor("ft8");
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };

    if (deviceId) {
      audioConstraints.deviceId = { exact: deviceId };
    }

    let mediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (e) {
      if (e.name === "OverconstrainedError" && e.constraint === "deviceId") {
        // Saved device ID is stale (Firefox reassigns IDs after reload) — use default
        const { deviceId: _dropped, ...rest } = audioConstraints;
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: rest });
      } else {
        throw e;
      }
    }

    const audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    const source = audioContext.createMediaStreamSource(mediaStream);
    const analyser = audioContext.createAnalyser();
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    analyser.fftSize = Number(els.ft8FftSize.value);
    analyser.smoothingTimeConstant = 0.15;
    source.connect(analyser);
    source.connect(processor);
    processor.connect(audioContext.destination);
    processor.onaudioprocess = handleFt8AudioProcess;

    ft8State.audioContext = audioContext;
    ft8State.audioStream = mediaStream;
    ft8State.audioSourceNode = source;
    ft8State.analyser = analyser;
    ft8State.processorNode = processor;
    ft8State.ft8SampleRate = audioContext.sampleRate;
    ft8State.ft8SampleBuffer = [];
    ft8State.lastFrameCaptureAt = 0;
    ft8State.syncQuality = 0;
    els.ft8AudioStatus.textContent = "Audio Live";
    els.ft8DecoderStatus.textContent = ft8State.ft8Decoder ? "Listening" : "Decoder Error";
    appendSerialLog("FT8 audio monitor started.");
    await audio.populateAllDevices();
    drawWaterfall();
  } catch (error) {
    els.ft8AudioStatus.textContent = "Audio Error";
    const detail = [error.name, error.message, error.constraint ? `constraint: ${error.constraint}` : ""].filter(Boolean).join(" — ");
    appendSerialLog(`FT8 audio monitor failed: ${detail}`);
  }
}

export async function stopFt8AudioMonitor() {
  if (ft8State.animationFrameId) {
    cancelAnimationFrame(ft8State.animationFrameId);
    ft8State.animationFrameId = null;
  }

  if (ft8State.audioStream) {
    ft8State.audioStream.getTracks().forEach((track) => track.stop());
    ft8State.audioStream = null;
  }

  if (ft8State.audioContext) {
    await ft8State.audioContext.close();
    ft8State.audioContext = null;
  }

  ft8State.audioSourceNode = null;
  ft8State.processorNode = null;
  ft8State.analyser = null;
  ft8State.ft8SampleRate = 0;
  ft8State.ft8SampleBuffer = [];
  ft8State.lastFrameCaptureAt = 0;
  ft8State.syncQuality = 0;
  ft8State.lastSymbolStream = [];
  ft8State.lastPayloadBits = "";
  ft8State.lastChannelBits = "";
  ft8State.lastSystematicBits = "";
  ft8State.ft8DecodedMessages = [];
  ft8State.ft8LastAutoDecodeAt = 0;
  els.ft8AudioStatus.textContent = "Audio Off";
  els.ft8DecoderStatus.textContent = ft8State.ft8Decoder ? "Decoder Ready" : "Decoder Error";
  els.ft8MeterFill.style.width = "0%";
  els.ft8NoiseFloor.textContent = "-- dB";
  els.ft8PeakTone.textContent = "-- Hz";
  els.ft8Activity.textContent = "Idle";
  if (els.ft8SymbolStream) els.ft8SymbolStream.value = "";
  if (els.ft8PayloadBits) els.ft8PayloadBits.value = "";
  if (els.ft8ChannelBits) els.ft8ChannelBits.value = "";
  renderFt8TextDecodes();
  updateFrameCaptureUi();
  ft8State.decoderCandidates = [];
  renderDecoderCandidates();
  clearWaterfall();
}

// Owns the "ft8-wf-tx-blank" class + peak/noise-floor/activity readout text
// while keyed — the part of main's updateRadioUi (the old monolith, b8a4189) that used
// to fire on every PTT change app-wide, independent of whether the FT8 audio
// monitor/session was running. Called from index.js's mount(), subscribed to
// the cat "ptt" event (plus once at mount with the current cat.getPtt()), so
// this clears on key-up regardless of whether drawWaterfall's rAF loop is
// alive — see the header note above. Matches main's values exactly: sets the
// blank text on key-down only; un-key relies on the same restore paths main
// had (drawWaterfall's own non-blanked frame repainting the readouts via
// updateExperimentalDecoder if a session is running, or stopFt8AudioMonitor
// resetting them to "Idle"/"-- dB"/"-- Hz" if the monitor stops) — main never
// wrote a restore value here either.
export function setTxBlank(transmitting) {
  els.ft8WfPanel?.classList.toggle("ft8-wf-tx-blank", transmitting);
  if (transmitting) {
    els.ft8PeakTone.textContent = "—";
    els.ft8NoiseFloor.textContent = "—";
    els.ft8Activity.textContent = "Transmitting";
  }
}

export function drawWaterfall() {
  if (!ft8State.analyser) {
    return;
  }

  const canvas = els.ft8Waterfall;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const spectrum = new Uint8Array(ft8State.analyser.frequencyBinCount);

  const renderFrame = () => {
    if (!ft8State.analyser) {
      return;
    }

    // Our own transmitted tone can leak into the RX audio path (VOX
    // loopback, mic pickup); paint a blank waterfall row and pin the meter
    // while keyed so it doesn't read as a bogus decode. cat.getPtt() is a
    // live read (not cached) so this tracks key-down/key-up every frame.
    // The "ft8-wf-tx-blank" class + peak/noise-floor/activity readouts are
    // owned by setTxBlank() (below), driven by the cat "ptt" event — not
    // here — so they clear on key-up even if this rAF loop isn't running.
    const transmitting = cat.getPtt();

    context.drawImage(canvas, 0, 0, width, height - 1, 0, 1, width, height - 1);

    if (transmitting) {
      context.fillStyle = waterfallColor(0);
      context.fillRect(0, 0, width, 1);
      els.ft8MeterFill.style.width = "4%";
    } else {
      ft8State.analyser.getByteFrequencyData(spectrum);

      const hzPerBin = (ft8State.ft8SampleRate || 44100) / (spectrum.length * 2);
      const startBin = Math.floor(200 / hzPerBin);
      const endBin = Math.min(spectrum.length - 1, Math.ceil(3000 / hzPerBin));
      const binSpan = endBin - startBin;

      let peak = 0;
      for (let x = 0; x < width; x += 1) {
        const bin = Math.min(spectrum.length - 1, startBin + Math.round((x / width) * binSpan));
        const value = spectrum[bin];
        peak = Math.max(peak, value);
        context.fillStyle = waterfallColor(value);
        context.fillRect(x, 0, 1, 1);
      }

      els.ft8MeterFill.style.width = `${Math.max(4, (peak / 255) * 100)}%`;
      updateExperimentalDecoder();
    }
    ft8State.animationFrameId = requestAnimationFrame(renderFrame);
  };

  renderFrame();
}

export function clearWaterfall() {
  const canvas = els.ft8Waterfall;
  const context = canvas.getContext("2d");
  context.fillStyle = "#050d16";
  context.fillRect(0, 0, canvas.width, canvas.height);
}

export function handleWaterfallClick(event) {
  event.preventDefault();
  const rect = els.ft8Waterfall.getBoundingClientRect();
  const hz = Math.round(200 + ((event.clientX - rect.left) / rect.width) * 2800);
  const clampedHz = Math.max(200, Math.min(3000, hz));
  const pct = ((clampedHz - 200) / 2800) * 100;

  if (event.type === "contextmenu") {
    els.ft8TxTone.value = String(clampedHz);
    updateFt8TxUi();
    appendSerialLog(`FT8 TX tone → ${clampedHz} Hz`);
  } else {
    if (els.ft8WfRxMarker) {
      els.ft8WfRxMarker.style.left = `${pct.toFixed(1)}%`;
      els.ft8WfRxMarker.dataset.label = `RX ${clampedHz}`;
    }
    if (els.whDisplayRxFreq) els.whDisplayRxFreq.value = String(clampedHz);
    appendSerialLog(`FT8 RX tuned → ${clampedHz} Hz`);
  }
}

function waterfallColor(value) {
  const hue = 220 - (value / 255) * 220;
  const lightness = 10 + (value / 255) * 65;
  return `hsl(${hue} 95% ${lightness}%)`;
}

function handleFt8AudioProcess(event) {
  const samples = event.inputBuffer.getChannelData(0);
  if (!samples?.length) {
    return;
  }

  for (let i = 0; i < samples.length; i += 1) {
    ft8State.ft8SampleBuffer.push(samples[i]);
  }

  const maxSamples = Math.floor((ft8State.ft8SampleRate || 12000) * 16);
  if (ft8State.ft8SampleBuffer.length > maxSamples) {
    ft8State.ft8SampleBuffer.splice(0, ft8State.ft8SampleBuffer.length - maxSamples);
  }

  analyzeFt8Frames();
  updateFrameCaptureUi();
}

export async function ensureFt8TxAudioContext() {
  if (!ft8State.ft8TxAudioContext) {
    ft8State.ft8TxAudioContext = new AudioContext({ sampleRate: 12000 });
    ft8State.ft8TxGainNode = ft8State.ft8TxAudioContext.createGain();
    ft8State.ft8TxGainNode.gain.value = 1.0;
    ft8State.ft8TxMediaDest = ft8State.ft8TxAudioContext.createMediaStreamDestination();
    ft8State.ft8TxGainNode.connect(ft8State.ft8TxMediaDest);
    ft8State.ft8TxSinkEl = new Audio();
    ft8State.ft8TxSinkEl.srcObject = ft8State.ft8TxMediaDest.stream;
    await applyFt8TxOutputDevice();
    await ft8State.ft8TxSinkEl.play().catch(err => {
      appendSerialLog(`FT8 TX audio: play() blocked — ${err.message}. Click anywhere on the page and retry.`);
    });
  }

  if (ft8State.ft8TxAudioContext.state === "suspended") {
    await ft8State.ft8TxAudioContext.resume();
  }
}

export async function applyFt8TxOutputDevice() {
  if (!ft8State.ft8TxSinkEl) return;
  if (typeof ft8State.ft8TxSinkEl.setSinkId !== "function") return;
  const deviceId = audio.outputFor("ft8");
  try {
    await ft8State.ft8TxSinkEl.setSinkId(deviceId || "");
    const outputEl = audio.getConfig().perAppMode
      ? document.querySelector("#ft8-audio-output")
      : document.querySelector("#global-audio-output");
    const label = deviceId
      ? ([...(outputEl?.options || [])].find(o => o.value === deviceId)?.text || deviceId)
      : "default output";
    appendSerialLog(`FT8 TX audio → ${label}`);
  } catch (err) {
    appendSerialLog(`FT8 TX audio output: setSinkId failed — ${err.message}`);
  }
}

export async function playFt8Waveform(waveform, sampleRate = 12000) {
  await ensureFt8TxAudioContext();

  const buffer = ft8State.ft8TxAudioContext.createBuffer(1, waveform.length, sampleRate);
  buffer.copyToChannel(waveform, 0);

  const source = ft8State.ft8TxAudioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(ft8State.ft8TxGainNode);
  ft8State.ft8TxSourceNode = source;

  await new Promise((resolve) => {
    source.onended = resolve;
    source.start();
  });

  ft8State.ft8TxSourceNode = null;
}
