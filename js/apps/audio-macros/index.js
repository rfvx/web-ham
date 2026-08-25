// Audio & Macros mini-app — the Audio Monitor (live spectrum + device routing)
// and the Voice Keyer (recorded and typed-TTS voice macros keyed over CAT PTT).
//
// Constraints worth knowing before changing anything here:
//
// - It owns #audio-perm-btn in the shell top strip, outside its own panel,
//   because that dot reflects the Audio Monitor's microphone permission and
//   nothing else reads it.
//
// - It publishes ctx.audioMonitor.sync(cfg), which js/shell/shell.js calls from
//   applyAudioDeviceConfig() when a global or per-app device changes. The shell
//   mounts BEFORE any app, so its one boot-time call happens while
//   ctx.audioMonitor is still undefined — hence the optional chaining at that
//   call site. Every later call comes from a device "change" handler.
//
// - It listens for bus "voice-keyer-refresh" (the voice macro row buttons are
//   enabled from radio-connected state, which the radio app owns) and for cat
//   "disconnect" (to tear down voice TX state along with the port).
//
// - Voice macros are stored in IndexedDB, not localStorage: they are audio
//   blobs, and localStorage holds the log.
import { escapeHtml } from "../../utils.js";
import { appendSerialLog } from "../../serial-log.js";

// ====== Voice Macro Database ======
const VOICE_DB_NAME = "WebHamVoiceDB";
const VOICE_STORE = "macros";

export default {
  id: "audio-macros",
  title: "Audio & Macros",
  mount(panelEl, ctx) {
    const { cat, audio, bus } = ctx;

    const els = {
      voiceKeyerStatus: document.querySelector("#voice-keyer-status"),
      voiceOutputDevice: document.querySelector("#voice-output-device"),
      voiceMacrosList: document.querySelector("#voice-macros-list"),
      addVoiceMacroBtn: document.querySelector("#add-voice-macro-btn"),
      voiceTtsText: document.querySelector("#voice-tts-text"),
      voiceTxTtsBtn: document.querySelector("#voice-tx-tts-btn"),
      audioMonitorOutputSelect: document.querySelector("#audio-monitor-output-select"),
      audioMonitorInputSelect: document.querySelector("#audio-monitor-input-select"),
      audioMonitorStartBtn: document.querySelector("#audio-monitor-start-btn"),
      audioMonitorStopBtn: document.querySelector("#audio-monitor-stop-btn"),
      audioMonitorStatus: document.querySelector("#audio-monitor-status"),
      audioMonitorInputLabel: document.querySelector("#audio-monitor-input-label"),
      audioMonitorSpectrum: document.querySelector("#audio-monitor-spectrum"),
      audioMonitorRelay: document.querySelector("#audio-monitor-relay"),
      audioMonitorRoutingStatus: document.querySelector("#audio-monitor-routing-status"),
      // Sidebar quick-toggle dot — outside #tab-audio-macros, see header note.
      audioPermBtn: document.querySelector("#audio-perm-btn"),
      // Shared debug log — outside #tab-audio-macros too (lives on the Radio
      // tab); js/apps/radio/index.js keeps its own #serial-log reference
      // (the DOM-write owner) for its own many callers, this app queries it
      // independently, same dual-query pattern the settings app uses for
      // #ft8-my-call etc.
    };


    // ====== Audio Monitor ======
    const audioMonitorState = {
      context: null,
      stream: null,
      sourceNode: null,
      analyser: null,
      destNode: null,
      relayAudioEl: null,
      animFrameId: null,
      peakBins: null,
      running: false
    };

    async function applyMonitorOutputDevice(deviceId) {
      const relay = els.audioMonitorRelay;
      if (!relay) return;
      if (typeof relay.setSinkId === "function") {
        try {
          await relay.setSinkId(deviceId || "");
        } catch (err) {
          appendSerialLog(`Audio Monitor: setSinkId failed — ${err.message}`);
        }
      } else {
        appendSerialLog("Audio Monitor: setSinkId not supported — using default output.");
      }
      // Update routing status label
      const inputTrack  = audioMonitorState.stream?.getAudioTracks()[0];
      const inputName   = inputTrack ? (inputTrack.label || "mic") : "—";
      const outputName = deviceId
        ? (els.audioMonitorOutputSelect
            ? ([...els.audioMonitorOutputSelect.options].find(o => o.value === deviceId)?.text || deviceId)
            : deviceId)
        : "Default output";
      if (els.audioMonitorRoutingStatus) {
        els.audioMonitorRoutingStatus.textContent = `Input: ${inputName} → Output: ${outputName}`;
      }
    }

    function drawSpectrumFrame() {
      const ams = audioMonitorState;
      if (!ams.running || !ams.analyser) return;

      const canvas = els.audioMonitorSpectrum;
      if (!canvas) return;
      const ctx2d = canvas.getContext("2d");
      const W   = canvas.width;
      const H   = canvas.height;
      const bins = ams.analyser.frequencyBinCount;
      const data = new Float32Array(bins);
      ams.analyser.getFloatFrequencyData(data);

      // Initialise peak-hold array on first frame
      if (!ams.peakBins || ams.peakBins.length !== bins) {
        ams.peakBins = new Float32Array(bins).fill(-160);
      }

      const style    = getComputedStyle(document.documentElement);
      const bgColor  = style.getPropertyValue("--paper-2").trim() || "#1a1a2e";
      const barColor = style.getPropertyValue("--accent").trim()   || "#4a9eff";
      const peakColor = style.getPropertyValue("--connected").trim() || "#7ecb82";

      ctx2d.fillStyle = bgColor;
      ctx2d.fillRect(0, 0, W, H);

      // Faint dB grid lines every 20 dB (−120 to 0)
      ctx2d.strokeStyle = "rgba(128,128,128,0.12)";
      ctx2d.lineWidth   = 1;
      for (let db = -120; db <= 0; db += 20) {
        const y = Math.round(H * (1 - (db + 120) / 120));
        ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke();
      }

      const barW = Math.max(1, Math.floor(W / bins));
      const gap  = 1;

      for (let i = 0; i < bins; i++) {
        const db   = Math.max(-120, data[i]);
        const norm = (db + 120) / 120;
        const barH = Math.round(norm * H);
        const x    = Math.round(i * (W / bins));
        const y    = H - barH;

        ctx2d.fillStyle = barColor;
        ctx2d.fillRect(x, y, Math.max(1, barW - gap), barH);

        // Peak-hold with slow decay
        if (db > ams.peakBins[i]) {
          ams.peakBins[i] = db;
        } else {
          ams.peakBins[i] = Math.max(db, ams.peakBins[i] - 0.5);
        }
        const peakY = Math.round(H * (1 - (ams.peakBins[i] + 120) / 120));
        ctx2d.fillStyle = peakColor;
        ctx2d.fillRect(x, peakY, Math.max(1, barW - gap), 2);
      }

      ams.animFrameId = requestAnimationFrame(drawSpectrumFrame);
    }

    async function startAudioMonitor() {
      if (!navigator.mediaDevices) {
        if (els.audioMonitorStatus) els.audioMonitorStatus.textContent = "No Media API";
        appendSerialLog("Audio Monitor: browser does not expose Media Capture APIs.");
        return;
      }

      // Stop any existing session first
      await stopAudioMonitor();

      try {
        const inputId = audio.inputFor("audio");
        const constraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false
        };
        if (inputId) constraints.deviceId = { exact: inputId };

        const stream     = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        const context    = new AudioContext();
        const sourceNode = context.createMediaStreamSource(stream);
        const analyser   = context.createAnalyser();
        analyser.fftSize               = 2048;
        analyser.smoothingTimeConstant = 0.8;
        const destNode   = context.createMediaStreamDestination();
        sourceNode.connect(analyser);
        sourceNode.connect(destNode);

        const relay = els.audioMonitorRelay;
        if (relay) {
          relay.srcObject = destNode.stream;
          if (relay.paused) {
            try { await relay.play(); } catch (_) { /* autoplay blocked — user must interact */ }
          }
        }

        const ams        = audioMonitorState;
        ams.context      = context;
        ams.stream       = stream;
        ams.sourceNode   = sourceNode;
        ams.analyser     = analyser;
        ams.destNode     = destNode;
        ams.relayAudioEl = relay;
        ams.peakBins     = null;
        ams.running      = true;

        // Apply chosen output device
        const outputId = els.audioMonitorOutputSelect?.value || audio.outputFor("audio");
        await applyMonitorOutputDevice(outputId);

        const trackLabel = stream.getAudioTracks()[0]?.label || "mic";
        if (els.audioMonitorInputLabel) els.audioMonitorInputLabel.textContent = trackLabel;
        if (els.audioMonitorStatus)     els.audioMonitorStatus.textContent     = "Live";
        if (els.audioMonitorStartBtn)   els.audioMonitorStartBtn.disabled      = true;
        if (els.audioMonitorStopBtn)    els.audioMonitorStopBtn.disabled       = false;

        appendSerialLog("Audio Monitor started.");
        syncAudioPermDot();
        drawSpectrumFrame();

      } catch (err) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          if (els.audioMonitorStatus) els.audioMonitorStatus.textContent = "Mic Denied";
          appendSerialLog("Audio Monitor: microphone access denied. Check browser permissions.");
        } else {
          if (els.audioMonitorStatus) els.audioMonitorStatus.textContent = "Error";
          appendSerialLog(`Audio Monitor start failed: ${err.message}`);
        }
      }
    }

    async function stopAudioMonitor() {
      const ams = audioMonitorState;
      if (ams.animFrameId) {
        cancelAnimationFrame(ams.animFrameId);
        ams.animFrameId = null;
      }
      if (ams.stream) {
        ams.stream.getTracks().forEach(t => t.stop());
        ams.stream = null;
      }
      if (ams.relayAudioEl) {
        ams.relayAudioEl.srcObject = null;
        ams.relayAudioEl           = null;
      }
      ams.running    = false;
      ams.sourceNode = null;
      ams.analyser   = null;
      ams.destNode   = null;
      ams.peakBins   = null;
      if (ams.context) {
        await ams.context.close();
        ams.context = null;
      }

      if (els.audioMonitorStatus)      els.audioMonitorStatus.textContent      = "Off";
      if (els.audioMonitorInputLabel)  els.audioMonitorInputLabel.textContent  = "—";
      if (els.audioMonitorStartBtn)    els.audioMonitorStartBtn.disabled       = false;
      if (els.audioMonitorStopBtn)     els.audioMonitorStopBtn.disabled        = true;
      if (els.audioMonitorRoutingStatus) {
        els.audioMonitorRoutingStatus.textContent = "Input: — → Output: —";
      }

      // Clear canvas
      const canvas = els.audioMonitorSpectrum;
      if (canvas) {
        const ctx2d = canvas.getContext("2d");
        const bg  = getComputedStyle(document.documentElement).getPropertyValue("--paper-2").trim() || "#1a1a2e";
        ctx2d.fillStyle = bg;
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      }

      appendSerialLog("Audio Monitor stopped.");
      syncAudioPermDot();
    }

    // Cross-panel seam for js/shell/shell.js's applyAudioDeviceConfig(). Was
    // `window.audioMonitorSync`; now a declared ctx capability like ctx.ft8 and
    // ctx.logger, so the shell reaches it the same way every other cross-app
    // call does instead of through a global the shell has to hope was assigned.
    ctx.audioMonitor = {};
    ctx.audioMonitor.sync = function syncAudioMonitorDevices(cfg) {
      if (!audioMonitorState.running) return;
      const track = audioMonitorState.stream?.getAudioTracks()[0];
      if (track && track.readyState === "ended") {
        void stopAudioMonitor();
        appendSerialLog("Audio Monitor: input device disconnected.");
        return;
      }
      const currentInputId = audioMonitorState.stream
        ?.getAudioTracks()[0]
        ?.getSettings()?.deviceId || "";
      const newInputId = audio.inputFor("audio");
      if (currentInputId !== newInputId) {
        void startAudioMonitor();
      } else {
        const monOutputEl = els.audioMonitorOutputSelect;
        const newOutputId = (monOutputEl && !cfg.perAppMode)
          ? cfg.globalOutput
          : (monOutputEl?.value || "");
        if (monOutputEl && !cfg.perAppMode) {
          monOutputEl.value = newOutputId;
        }
        void applyMonitorOutputDevice(newOutputId);
      }
    };

    // Sidebar audio-perm quick-toggle dot — see header note.
    function syncAudioPermDot() {
      const btn = els.audioPermBtn;
      if (!btn) return;
      if (audioMonitorState.running) {
        btn.dataset.state = "live";
        btn.title = "Audio feed live — click to stop";
      } else if (btn.dataset.state === "live") {
        btn.dataset.state = "granted";
        btn.title = "Audio ready — click to start feed";
      }
    }

    async function initAudioPermDot() {
      const btn = els.audioPermBtn;
      if (!btn) return;

      function setState(s) {
        if (s === "live") {
          btn.dataset.state = "live";
          btn.title = "Audio feed live — click to stop";
        } else if (s === "granted") {
          btn.dataset.state = "granted";
          btn.title = "Audio ready — click to start feed";
        } else if (s === "denied") {
          btn.dataset.state = "denied";
          btn.title = "Audio permission denied — click to retry";
        } else {
          delete btn.dataset.state;
          btn.title = "Click to start audio feed";
        }
      }

      if (navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: "microphone" });
          setState(status.state === "prompt" ? null : status.state);
          status.onchange = () => {
            if (!audioMonitorState.running) {
              setState(status.state === "prompt" ? null : status.state);
            }
          };
        } catch { /* permissions API unsupported — leave unknown */ }
      }

      btn.addEventListener("click", async () => {
        if (audioMonitorState.running) {
          await stopAudioMonitor();
        } else {
          delete btn.dataset.state;
          await startAudioMonitor();
          if (audioMonitorState.running) {
            setState("live");
            await audio.populateAllDevices();
          } else {
            setState("denied");
          }
        }
      });
    }

    // ====== Voice Keyer ======
    function getVoiceDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(VOICE_DB_NAME, 1);
        request.onupgradeneeded = (e) => {
          e.target.result.createObjectStore(VOICE_STORE, { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function loadVoiceMacrosDb() {
      return getVoiceDB().then((db) => {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(VOICE_STORE, "readonly");
          const store = tx.objectStore(VOICE_STORE);
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
      });
    }

    function saveVoiceMacroDb(macro) {
      return getVoiceDB().then((db) => {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(VOICE_STORE, "readwrite");
          const store = tx.objectStore(VOICE_STORE);
          const request = store.put(macro);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error);
        });
      });
    }

    function deleteVoiceMacroDb(id) {
      return getVoiceDB().then((db) => {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(VOICE_STORE, "readwrite");
          const store = tx.objectStore(VOICE_STORE);
          const request = store.delete(id);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error);
        });
      });
    }

    let voiceStatus = "Idle";
    let voiceMacros = [];
    let voiceRecordingMacroId = null;
    let voiceTxInProgress = false;

    async function initVoiceMacros() {
      try {
        const macros = await loadVoiceMacrosDb();
        voiceMacros = macros.map(m => ({ ...m, url: URL.createObjectURL(m.blob) }));
      } catch (error) {
        appendSerialLog(`Failed to load voice macros: ${error.message}`);
      }
    }

    async function addVoiceMacro() {
      const id = Date.now().toString();
      const name = prompt("Enter a name for this voice macro:", `Macro ${voiceMacros.length + 1}`);
      if (!name) {
        return;
      }

      const macro = { id, name, blob: new Blob([], { type: "audio/webm" }) };
      voiceMacros.push({ ...macro, url: "" });
      updateVoiceKeyerUi();
    }

    async function deleteVoiceMacro(id) {
      const macro = voiceMacros.find(m => m.id === id);
      if (macro && macro.url) {
        URL.revokeObjectURL(macro.url);
      }
      voiceMacros = voiceMacros.filter(m => m.id !== id);
      await deleteVoiceMacroDb(id);
      updateVoiceKeyerUi();
    }

    function updateVoiceKeyerUi() {
      const connected = cat.isConnected();
      els.voiceKeyerStatus.textContent = voiceStatus;

      els.voiceMacrosList.innerHTML = voiceMacros.map(macro => `
        <div class="voice-macro-row" data-id="${escapeHtml(macro.id)}">
          <strong>${escapeHtml(macro.name)}</strong>
          <div class="button-row compact">
            ${voiceRecordingMacroId === macro.id
              ? `<button type="button" class="secondary" data-action="stop">Stop</button>`
              : `<button type="button" class="secondary" data-action="record" ${voiceRecordingMacroId || voiceTxInProgress ? "disabled" : ""}>Record</button>`
            }
            <button type="button" class="secondary" data-action="play" ${!macro.url || voiceRecordingMacroId || voiceTxInProgress ? "disabled" : ""}>Play</button>
            <button type="button" class="secondary" data-action="tx" ${!macro.url || voiceRecordingMacroId || voiceTxInProgress || !connected ? "disabled" : ""}>TX</button>
            <button type="button" class="secondary" data-action="delete" ${voiceRecordingMacroId ? "disabled" : ""}>Del</button>
          </div>
        </div>
      `).join("");

      els.addVoiceMacroBtn.disabled = Boolean(voiceRecordingMacroId);
      els.voiceTxTtsBtn.disabled = voiceTxInProgress || !connected;
    }

    function handleVoiceMacroAction(event) {
      const btn = event.target.closest("button[data-action]");
      if (!btn) {
        return;
      }
      const row = btn.closest("[data-id]");
      if (!row) {
        return;
      }

      const id = row.dataset.id;
      const action = btn.dataset.action;

      if (action === "record") {
        void startVoiceRecording(id);
      } else if (action === "stop") {
        stopVoiceRecording(id);
      } else if (action === "play") {
        void playVoiceMacroLocally(id);
      } else if (action === "tx") {
        void transmitRecordedVoiceClip(id);
      } else if (action === "delete") {
        if (confirm("Delete this voice macro?")) {
          void deleteVoiceMacro(id);
        }
      }
    }

    let activeRecorder = null;
    let activeRecorderStream = null;
    let activeRecorderChunks = [];

    async function startVoiceRecording(id) {
      if (voiceRecordingMacroId) {
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        appendSerialLog("Voice recording is unavailable in this browser.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        activeRecorder = new MediaRecorder(stream);
        activeRecorderChunks = [];
        activeRecorderStream = stream;

        activeRecorder.ondataavailable = (event) => {
          if (event.data?.size) {
            activeRecorderChunks.push(event.data);
          }
        };

        activeRecorder.onstop = async () => {
          const blobType = activeRecorder.mimeType || "audio/webm";
          const blob = new Blob(activeRecorderChunks, { type: blobType });

          const idx = voiceMacros.findIndex(m => m.id === id);
          if (idx !== -1) {
            const macro = voiceMacros[idx];
            if (macro.url) {
              URL.revokeObjectURL(macro.url);
            }
            macro.blob = blob;
            macro.url = URL.createObjectURL(blob);
            await saveVoiceMacroDb({ id: macro.id, name: macro.name, blob });
          }

          activeRecorderChunks = [];
          activeRecorder = null;
          if (activeRecorderStream) {
            activeRecorderStream.getTracks().forEach(t => t.stop());
            activeRecorderStream = null;
          }

          voiceRecordingMacroId = null;
          voiceStatus = "Idle";
          updateVoiceKeyerUi();
          appendSerialLog("Voice macro recorded and saved.");
        };

        activeRecorder.start();
        voiceRecordingMacroId = id;
        voiceStatus = "Recording";
        updateVoiceKeyerUi();
        appendSerialLog("Recording voice macro...");
      } catch (error) {
        appendSerialLog(`Voice recording failed: ${error.message}`);
      }
    }

    function stopVoiceRecording(id) {
      if (voiceRecordingMacroId !== id || !activeRecorder) {
        return;
      }
      activeRecorder.stop();
      voiceStatus = "Processing recording";
      updateVoiceKeyerUi();
    }

    async function playVoiceMacroLocally(id) {
      const macro = voiceMacros.find(m => m.id === id);
      if (!macro || !macro.blob) {
        return;
      }
      await playAudioBlobToOutput(macro.blob);
    }

    async function transmitRecordedVoiceClip(id) {
      const macro = voiceMacros.find(m => m.id === id);
      if (!macro || !macro.blob) {
        appendSerialLog("Record a voice clip first.");
        return;
      }
      await transmitVoiceMessage(`Voice Macro: ${macro.name}`, () => playAudioBlobToOutput(macro.blob));
    }

    async function transmitTypedTextToSpeech() {
      const text = els.voiceTtsText.value.trim();
      if (!text) {
        appendSerialLog("Type a message before transmitting text-to-speech.");
        return;
      }

      await transmitVoiceMessage(`TTS: ${text}`, () => playSpeechMessage(text));
    }

    async function transmitVoiceMessage(description, playHandler) {
      if (!cat.isConnected()) {
        appendSerialLog("Connect the radio before voice keying.");
        return;
      }

      if (voiceTxInProgress) {
        appendSerialLog("Voice keyer is already transmitting.");
        return;
      }

      voiceTxInProgress = true;
      voiceStatus = "PTT On";
      updateVoiceKeyerUi();

      try {
        await cat.setPtt(true);
        voiceStatus = "Transmitting";
        updateVoiceKeyerUi();
        await playHandler();
        appendSerialLog(`Voice TX complete (${description}).`);
      } catch (error) {
        appendSerialLog(`Voice TX failed: ${error.message}`);
      } finally {
        try {
          await cat.setPtt(false);
        } catch {
          // Ignore PTT cleanup errors after reporting the transmit result.
        }
        voiceTxInProgress = false;
        voiceStatus = "Idle";
        updateVoiceKeyerUi();
      }
    }

    // Was `state.voiceOutputDeviceId` — now read directly from the select's
    // own value (see header note: the state field was a redundant mirror).
    async function playAudioBlobToOutput(blob) {
      const objectUrl = URL.createObjectURL(blob);
      try {
        const audio = new Audio(objectUrl);
        const voiceOutputDeviceId = els.voiceOutputDevice?.value || "";
        if (voiceOutputDeviceId && typeof audio.setSinkId === "function") {
          await audio.setSinkId(voiceOutputDeviceId);
        }
        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = () => reject(new Error("Audio playback failed."));
          const playback = audio.play();
          if (playback?.catch) {
            playback.catch(reject);
          }
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    async function playSpeechMessage(text) {
      const ttsUrl = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=en&q=${encodeURIComponent(text)}`;

      try {
        const audio = new Audio();
        const voiceOutputDeviceId = els.voiceOutputDevice?.value || "";
        if (voiceOutputDeviceId && typeof audio.setSinkId === "function") {
          await audio.setSinkId(voiceOutputDeviceId);
        }

        // Some free APIs allow cross-origin audio elements to play directly
        // Note: Due to browser security, cross-origin objects might throw if played using setSinkId,
        // but the fallback to default output happens cleanly or we can proxy via allorigins.
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(ttsUrl)}`);
        if (!res.ok) {
          throw new Error("TTS proxy failed");
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        audio.src = objectUrl;

        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = () => reject(new Error("Audio playback failed."));
          const playback = audio.play();
          if (playback?.catch) {
            playback.catch(reject);
          }
        });
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        // Basic browser speech fallback. Native SpeechSynthesis API does NOT support output device switching yet.
        if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
          throw new Error("Speech synthesis is unavailable in this browser.");
        }
        window.speechSynthesis.cancel();
        await new Promise((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.onend = resolve;
          utterance.onerror = (event) => reject(new Error(event.error || "Speech synthesis failed."));
          window.speechSynthesis.speak(utterance);
        });
      }
    }

    // ====== Wiring ======
    els.addVoiceMacroBtn?.addEventListener("click", () => { void addVoiceMacro(); });
    els.voiceMacrosList?.addEventListener("click", handleVoiceMacroAction);
    els.voiceTxTtsBtn?.addEventListener("click", () => { void transmitTypedTextToSpeech(); });

    els.audioMonitorStartBtn?.addEventListener("click", () => { void startAudioMonitor(); });
    els.audioMonitorStopBtn?.addEventListener("click", () => { void stopAudioMonitor(); });
    els.audioMonitorOutputSelect?.addEventListener("change", (e) => {
      audio.getConfig().perApp.audio.output = e.target.value;
      audio.saveDeviceConfig();
      void applyMonitorOutputDevice(e.target.value);
    });
    els.audioMonitorInputSelect?.addEventListener("change", (e) => {
      audio.getConfig().perApp.audio.input = e.target.value;
      audio.saveDeviceConfig();
    });

    // Cat "disconnect" seam (
    // header note): disconnectRadio() used to also clean up this
    // monolith-only voice-keyer state right after tearing the port down.
    // These three are never assigned anywhere — dead fields from an earlier
    // version of the recorder. Kept as always-undefined locals so the cleanup
    // below stays a no-op for them rather than throwing on an unknown name.
    let voiceMediaRecorder;
    let voiceRecorderStream;
    let voiceClipBlob;
    cat.addEventListener("disconnect", () => {
      voiceTxInProgress = false;
      if (voiceMediaRecorder) {
        try {
          voiceMediaRecorder.stop();
        } catch {}
        voiceMediaRecorder = null;
      }
      if (voiceRecorderStream) {
        voiceRecorderStream.getTracks().forEach((track) => track.stop());
        voiceRecorderStream = null;
      }
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      voiceStatus = voiceClipBlob ? "Recorded clip ready" : "Idle";
    });

    // See header note: replaces the old monolith updateRadioUi()'s old bare
    // updateVoiceKeyerUi() tail call. re-seamed from the cat
    // connector onto js/bus.js now that it exists.
    bus.addEventListener("voice-keyer-refresh", () => updateVoiceKeyerUi());

    // Boot-order note: this ran later in the monolith's old init() (after several
    // awaits), well after main.js mounted every app. Running it directly
    // from mount() instead is an earlier-but-harmless reordering — same
    // "safe to run at mount time" reasoning as the settings app's loadSettings()
    // move (see js/apps/settings/index.js and).
    void (async () => {
      try {
        await initVoiceMacros();
        updateVoiceKeyerUi();
      } catch (e) { console.warn("Voice macros init failed", e); }
    })();

    void initAudioPermDot();
  }
};
