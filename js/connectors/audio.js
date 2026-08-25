// Audio connector — which input and output device each mini-app uses, and the
// device-list population that fills every audio <select> in the app.
//
// Two routing modes: a global pair of devices shared by everything, or per-app
// selection. inputFor(appId)/outputFor(appId) resolve that, so callers never
// have to know which mode is active.
//
// Events: "log" (a line for the activity strip).
import { KEYS } from "./settings.js";
import { escapeHtml } from "../utils.js";

let config = {
  perAppMode: false,
  globalInput: "",
  globalOutput: "",
  perApp: {
    ft8:   { input: "", output: "" },
    sstv:  { input: "", output: "" },
    audio: { input: "", output: "" }
  }
};

export const audio = Object.assign(new EventTarget(), {
  loadDeviceConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEYS.AUDIO_DEVICE_CONFIG_KEY) || "{}");
      config = {
        perAppMode: saved.perAppMode === true,
        globalInput: saved.globalInput || "",
        globalOutput: saved.globalOutput || "",
        perApp: {
          ft8:   { input: saved.perApp?.ft8?.input   || "", output: saved.perApp?.ft8?.output   || "" },
          sstv:  { input: saved.perApp?.sstv?.input  || "", output: saved.perApp?.sstv?.output  || "" },
          audio: { input: saved.perApp?.audio?.input || "", output: saved.perApp?.audio?.output || "" }
        }
      };
    } catch {
      /* keep defaults */
    }
  },

  // "devices-change" per the brief (nothing consumes it yet — same
  // forward-compat posture as cat.js's unconsumed events pre-Task-9).
  saveDeviceConfig() {
    localStorage.setItem(KEYS.AUDIO_DEVICE_CONFIG_KEY, JSON.stringify(config));
    this.dispatchEvent(new CustomEvent("devices-change", { detail: config }));
  },

  // Was `state.audioDeviceConfig` — returns the live config object by
  // reference (callers mutate nested fields directly, exactly like the old
  // `state.audioDeviceConfig.x = y` pattern).
  getConfig() {
    return config;
  },

  inputFor(appId) {
    if (config.perAppMode) {
      return config.perApp[appId]?.input || "";
    }
    return config.globalInput || "";
  },

  outputFor(appId) {
    if (config.perAppMode) {
      return config.perApp[appId]?.output || "";
    }
    return config.globalOutput || "";
  },

  // <select>s it owns directly, per the brief — via its own element lookups
  // mirroring exactly the els.* entries the original touched
  // (els.ft8AudioDevice, els.voiceOutputDevice, els.globalAudioInput,
  // els.globalAudioOutput; everything else was already document.querySelector).
  //
  // Deviation from the brief's no-arg sketch: the original also read/wrote
  // `state.voiceOutputDeviceId`, monolith-only state this module can't reach.
  // `getVoiceOutputId`/`setVoiceOutputId` are optional accessor callbacks
  // (mirrors the connectPsk(call, isFt8Active) precedent in spots.js) so the
  // read/write happens at the exact same point in the flow as the original.
  async populateAllDevices(getVoiceOutputId, setVoiceOutputId) {
    const ft8AudioDeviceEl    = document.querySelector("#ft8-audio-device");
    const voiceOutputDeviceEl = document.querySelector("#voice-output-device");
    const globalAudioInputEl  = document.querySelector("#global-audio-input");
    const globalAudioOutputEl = document.querySelector("#global-audio-output");

    if (!navigator.mediaDevices?.enumerateDevices) {
      const msg = '<option value="">Audio device list unavailable</option>';
      [
        ft8AudioDeviceEl, voiceOutputDeviceEl,
        globalAudioInputEl, globalAudioOutputEl,
        document.querySelector("#ft8-audio-output"),
        document.querySelector("#sstv-audio-input-select"),
        document.querySelector("#sstv-audio-output-select"),
        document.querySelector("#audio-monitor-input-select"),
        document.querySelector("#audio-monitor-output-select")
      ].forEach(el => { if (el) el.innerHTML = msg; });
      return;
    }

    try {
      const devices        = await navigator.mediaDevices.enumerateDevices();
      const inputDevices   = devices.filter(d => d.kind === "audioinput");
      const outputDevices  = devices.filter(d => d.kind === "audiooutput");

      function buildInputOptions() {
        if (!inputDevices.length) return '<option value="">No audio inputs found</option>';
        return [
          '<option value="">Default audio input</option>',
          ...inputDevices.map((d, i) => {
            const label = escapeHtml(d.label || `Audio Input ${i + 1}`);
            return `<option value="${escapeHtml(d.deviceId)}">${label}</option>`;
          })
        ].join("");
      }

      function buildOutputOptions() {
        if (!outputDevices.length) return '<option value="">No audio outputs found</option>';
        return [
          '<option value="">Default system output</option>',
          ...outputDevices.map((d, i) => {
            const label = escapeHtml(d.label || `Audio Output ${i + 1}`);
            return `<option value="${escapeHtml(d.deviceId)}">${label}</option>`;
          })
        ].join("");
      }

      const OUTPUT_SELECTORS = [
        "#voice-output-device", "#global-audio-output",
        "#ft8-audio-output", "#sstv-audio-output-select", "#audio-monitor-output-select"
      ];

      function restoreSelect(el, savedValue) {
        if (!el) return;
        const isOutput = OUTPUT_SELECTORS.some(sel => document.querySelector(sel) === el);
        el.innerHTML = isOutput ? buildOutputOptions() : buildInputOptions();
        if ([...el.options].some(o => o.value === savedValue)) {
          el.value = savedValue;
        }
      }

      // Input selects
      restoreSelect(ft8AudioDeviceEl,   config.perApp.ft8.input);
      restoreSelect(globalAudioInputEl, config.globalInput);
      restoreSelect(document.querySelector("#sstv-audio-input-select"),      config.perApp.sstv.input);
      restoreSelect(document.querySelector("#audio-monitor-input-select"),   config.perApp.audio.input);

      // Output selects
      const currentVoiceOutput = (getVoiceOutputId ? getVoiceOutputId() : "") || voiceOutputDeviceEl?.value || "";
      restoreSelect(voiceOutputDeviceEl, currentVoiceOutput);
      restoreSelect(globalAudioOutputEl, config.globalOutput);
      restoreSelect(document.querySelector("#ft8-audio-output"),             config.perApp.ft8.output);
      restoreSelect(document.querySelector("#sstv-audio-output-select"),     config.perApp.sstv.output);
      restoreSelect(document.querySelector("#audio-monitor-output-select"),  config.perApp.audio.output);

      // Keep voiceOutputDeviceId in sync
      if (voiceOutputDeviceEl && [...voiceOutputDeviceEl.options].some(o => o.value === currentVoiceOutput)) {
        voiceOutputDeviceEl.value = currentVoiceOutput;
        if (setVoiceOutputId) setVoiceOutputId(currentVoiceOutput);
      } else {
        if (setVoiceOutputId) setVoiceOutputId("");
      }

    } catch (error) {
      this.dispatchEvent(new CustomEvent("log", { detail: `Audio device query failed: ${error.message}` }));
    }
  },
});
