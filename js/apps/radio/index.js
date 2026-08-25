// Radio mini-app — the Radio tab console (frequency/mode readouts, inline
// frequency edit, step buttons, mode quick-select, PTT, the radio profile +
// serial connection card, and the CW macro keyer), plus the mission-dashboard
// summary strip that renders on the FT8 tab.
//
// Constraints worth knowing before changing anything here:
//
// - This app writes to elements in three other tabs. #pota-status is on Spots;
//   the mission dashboard (#wh-sum-*, #wh-display-rx-freq) is on FT8; the
//   frequency and mode fields it keeps in step with the VFO (#frequency, #mode,
//   #band-quickset, #mode-quickset and their chips) are on the Logger. Those are
//   queried from `document`, not `panelEl`, which is the shared convention for
//   reaching outside your own panel.
//
// - "Does the log's frequency/mode follow the live VFO" is state BOTH this app
//   and the logger read and write, so it lives on the cat connector
//   (getFreqFollow/setFreqFollow, getModeFollow/setModeFollow) rather than
//   privately here.
//
// - The operator's grid comes from ctx.settings.get().ft8MyGrid, never from the
//   FT8 tab's input. The settings connector is the single source of truth.
//
// - Bus events this app LISTENS for, because the app that owns the trigger
//   cannot reach this module's state: "freq-band-chip-refresh",
//   "mode-quickset-refresh", "radio-console-sync". Two separate refresh events
//   rather than one, deliberately — some callers want the band chip refreshed
//   from a value they just wrote themselves, without syncRadioConsole()
//   overwriting it from the live VFO.
//
// - Bus events this app DISPATCHES for the same reason: "radio-profile-changed"
//   (logger reseeds the QSO form's rig field), "dupe-banner-refresh",
//   "frequency-display-updated" (FT8 highlights the matching band row).
//
// - FT8 state is read through ctx.ft8 (txInProgress, pruneDecodeTimestamps) and
//   is undefined until that app mounts, so every read is optional-chained.
//
// - appendSerialLog is the shared one in js/serial-log.js. It used to be eight
//   copies, and this app owned the write the other seven routed to.
import {
  digiDisplayLabel, escapeHtml, parseFrequencyText,
  inferBandFromFrequency, mhzToBandName, formatSidebarVfo,
} from "../../utils.js";
import { RADIO_PROFILES, buildCivPacket, getSelectedModeLabel } from "../../connectors/cat.js";
import { appendSerialLog } from "../../serial-log.js";

const CW_MORSE_MAP = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  0: "-----",
  1: ".----",
  2: "..---",
  3: "...--",
  4: "....-",
  5: ".....",
  6: "-....",
  7: "--...",
  8: "---..",
  9: "----.",
  "/": "-..-.",
  "?": "..--..",
  ".": ".-.-.-",
  ",": "--..--",
  "=": "-...-"
};

export default {
  id: "radio",
  title: "Radio Dashboard",
  mount(panelEl, ctx) {
    const { cat, spots, audio, bus } = ctx;

    let cwMacroInProgress = false;

    const els = {
      // Cross-tab: shell top strip (connection pill + disconnect button —
      // same header area as the sidebar VFO fields below, outside every tab
      // panel). Verified by grep against index.html: #connection-status is
      // the topstrip's connection-pill <strong>, #disconnect-btn its button;
      // panelEl.querySelector() returned null for both (they're not
      // descendants of #tab-radio), which threw in updateRadioUi() on
      // mount() — same dual-query pattern as the sidebar VFO fields.
      connectionStatus: document.querySelector("#connection-status"),
      disconnectBtn: document.querySelector("#disconnect-btn"),
      // Cross-tab: Audio and Macros tab (the CW Keyer card lives in
      // #tab-audio-macros in index.html, not #tab-radio, despite being
      // radio-console logic). Same fix as above.
      sendCwMacroBtn: document.querySelector("#send-cw-macro-btn"),
      cwMacroText: document.querySelector("#cw-macro-text"),
      cwMacroWpm: document.querySelector("#cw-macro-wpm"),
      radioBadge: panelEl.querySelector("#radio-badge"),
      connectBtn: panelEl.querySelector("#connect-btn"),
      reconnectBtn: panelEl.querySelector("#reconnect-btn"),
      pttBtn: panelEl.querySelector("#ptt-btn"),
      pttStatus: panelEl.querySelector("#ptt-status"),
      radioModeDisplay: panelEl.querySelector("#radio-mode-display"),
      modeQuickGrid: panelEl.querySelector("#mode-quick-grid"),
      radioFrequencyDisplay: panelEl.querySelector("#radio-frequency-display"),
      stepButtons: [...panelEl.querySelectorAll("[data-step-hz]")],
      radioProfile: panelEl.querySelector("#radio-profile"),
      baudRate: panelEl.querySelector("#baud-rate"),
      dataBits: panelEl.querySelector("#data-bits"),
      stopBits: panelEl.querySelector("#stop-bits"),
      parity: panelEl.querySelector("#parity"),
      flowControl: panelEl.querySelector("#flow-control"),
      civAddrLabel: panelEl.querySelector("#civ-addr-label"),
      civAddress: panelEl.querySelector("#civ-address"),
      bridgeUrlLabel: panelEl.querySelector("#bridge-url-label"),
      bridgeUrl: panelEl.querySelector("#bridge-url"),
      serialSettings: [...panelEl.querySelectorAll(".wh-serial-setting")],
      serialSupportStatus: panelEl.querySelector("#serial-support-status"),

      // sidebarVfoFreq/sidebarVfoMode/sidebarSmeterFill/
      // sidebarSmeterText/sidebarFootStatus moved to js/shell/shell.js,
      // which now owns the sidebar VFO header writes that used to live
      // inline in updateFrequencyDisplay/syncRadioConsole/
      // updateMissionDashboard below (each marked with a comment at the
      // time) — see that file's header note for the wiring decision.

      // Cross-tab: FT8 tab (mission dashboard strip + RX freq echo).
      whSumUtc: document.querySelector("#wh-sum-utc"),
      whSumBand: document.querySelector("#wh-sum-band"),
      whSumGrid: document.querySelector("#wh-sum-grid"),
      whSumDecodes: document.querySelector("#wh-sum-decodes"),
      whDisplayRxFreq: document.querySelector("#wh-display-rx-freq"),

      // Cross-tab: Spots tab (status text).
      potaStatus: document.querySelector("#pota-status"),

      // Cross-tab: Logger tab (radio-follow frequency field + band chip/quickset).
      frequencyInput: document.querySelector("#frequency"),
      freqBandChip: document.querySelector("#freq-band-chip"),
      bandInput: document.querySelector("#band"),
      bandQuickset: document.querySelector("#band-quickset"),
      freqRadioChip: document.querySelector("#freq-radio-chip"),
      freqRadioChipLabel: document.querySelector("#freq-radio-chip-label"),
      modeInput: document.querySelector("#mode"),
      modeQuickset: document.querySelector("#mode-quickset"),
      modeRadioChip: document.querySelector("#mode-radio-chip"),
      modeRadioChipLabel: document.querySelector("#mode-radio-chip-label"),

    };


    function updateRadioUi() {
      const profile = cat.getProfile();
      const noRadio = profile?.protocol === "none";
      const connected = !noRadio && cat.isConnected();
      els.connectionStatus.textContent = noRadio ? "No Radio" : connected ? `${profile.name} Connected` : `${profile.name} Disconnected`;
      els.radioBadge.textContent = noRadio ? "Audio Only" : connected ? "Online" : "Offline";
      els.connectBtn.disabled = noRadio || connected;
      els.connectBtn.style.display = noRadio ? "none" : "";
      els.reconnectBtn.style.display = noRadio ? "none" : "";
      els.disconnectBtn.disabled = !connected;
      els.sendCwMacroBtn.disabled = !connected || cwMacroInProgress;
      els.cwMacroText.disabled = !connected || cwMacroInProgress;
      els.cwMacroWpm.disabled = !connected || cwMacroInProgress;
      els.sendCwMacroBtn.textContent = cwMacroInProgress ? "Sending CW..." : "Send CW Macro";
      els.pttBtn.disabled = !connected;
      els.pttBtn.classList.toggle("ptt-active", cat.getPtt());
      els.pttStatus.textContent = cat.getPtt() ? "TX" : "RX";
      els.pttStatus.classList.toggle("muted", !cat.getPtt());
      syncRadioConsole();
      // The voice-keyer row buttons are enabled from radio-connected state, but
      // live in the audio-macros app — it re-renders off this event.
      bus.dispatchEvent(new CustomEvent("voice-keyer-refresh"));
    }

    function syncRadioConsole() {
      const displayHz = cat.getStagedFrequency() || parseFrequencyText(cat.getFrequency());
      updateFrequencyDisplay(displayHz);
      els.radioModeDisplay.textContent = cat.getMode() || getSelectedModeLabel() || "Unknown";
      // the sidebarVfoMode/sidebarSmeterFill/sidebarSmeterText
      // writes that used to sit here moved to js/shell/shell.js, which
      // listens for cat "mode"/"status" directly instead.
      [...els.modeQuickGrid.querySelectorAll("[data-mode-value]")].forEach((button) => {
        button.classList.toggle("active", button.dataset.modeValue === cat.getStagedMode());
      });
      syncLoggerFreqFollow(displayHz);
      syncLoggerModeFollow(cat.getMode() || getSelectedModeLabel() || "");
    }

    // Mirrors the rig's live frequency into the logger's radio-follow chip, and
    // (while cat.getFreqFollow() is true) into the Frequency field itself.
    function syncLoggerFreqFollow(displayHz) {
      if (!els.freqRadioChipLabel) return;
      els.freqRadioChipLabel.textContent = displayHz > 0 ? `radio ${(displayHz / 1e6).toFixed(3)}` : "radio —";
      els.freqRadioChip?.classList.toggle("following", cat.getFreqFollow());
      if (cat.getFreqFollow() && displayHz > 0 && els.frequencyInput && document.activeElement !== els.frequencyInput) {
        els.frequencyInput.value = (displayHz / 1e6).toFixed(3);
        updateFreqBandChip();
      }
    }

    // mirrors the rig's live mode into the
    // logger's radio-follow chip, and (while cat.getModeFollow() is true)
    // into the Mode field itself. Same shape as syncLoggerFreqFollow above.
    function syncLoggerModeFollow(modeLabel) {
      if (!els.modeRadioChipLabel) return;
      els.modeRadioChipLabel.textContent = modeLabel ? `radio ${modeLabel}` : "radio —";
      els.modeRadioChip?.classList.toggle("following", cat.getModeFollow());
      if (cat.getModeFollow() && modeLabel && els.modeInput && document.activeElement !== els.modeInput) {
        els.modeInput.value = modeLabel;
        updateModeQuickButtons();
      }
    }

    // the sidebarVfoFreq write that used to sit in both branches
    // here moved to js/shell/shell.js's updateSidebarVfoFreq(), which
    // listens for cat "frequency" directly instead.
    function updateFrequencyDisplay(frequencyHz) {
      if (els.radioFrequencyDisplay.dataset.editing === "1") return;
      if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
        els.radioFrequencyDisplay.textContent = "--.---.---";
        if (els.whDisplayRxFreq) els.whDisplayRxFreq.value = "—";
        // highlightFt8BandRow is FT8 tab UI, which moved to
        // js/apps/ft8/index.js — see this file's header note.
        bus.dispatchEvent(new CustomEvent("frequency-display-updated", { detail: 0 }));
        return;
      }

      els.radioFrequencyDisplay.textContent = (frequencyHz / 1_000_000).toFixed(3);
      if (els.whDisplayRxFreq) {
        els.whDisplayRxFreq.value = formatSidebarVfo(frequencyHz);
      }
      bus.dispatchEvent(new CustomEvent("frequency-display-updated", { detail: frequencyHz }));
    }

    function startInlineFrequencyEdit(e) {
      if (e) e.stopPropagation();
      if (els.radioFrequencyDisplay.dataset.editing === "1") return;
      els.radioFrequencyDisplay.dataset.editing = "1";

      const currentMhz = cat.getStagedFrequency() > 0
        ? (cat.getStagedFrequency() / 1_000_000).toFixed(3)
        : (parseFrequencyText(cat.getFrequency()) / 1_000_000).toFixed(3);

      const input = document.createElement("input");
      input.type = "text";
      input.className = "frequency-readout-input";
      input.value = currentMhz === "0.000" ? "" : currentMhz;
      input.placeholder = "14.074";
      input.title = "Enter frequency in MHz, press Enter";

      const parent = els.radioFrequencyDisplay.parentElement;
      parent.insertBefore(input, els.radioFrequencyDisplay);
      els.radioFrequencyDisplay.style.display = "none";

      let committed = false;
      function commit() {
        if (committed) return;
        committed = true;
        const raw = input.value.trim().replace(/[^\d.]/g, "");
        const mhz = parseFloat(raw);
        if (input.parentNode) input.parentNode.removeChild(input);
        els.radioFrequencyDisplay.style.display = "";
        delete els.radioFrequencyDisplay.dataset.editing;
        if (Number.isFinite(mhz) && mhz > 0) {
          void cat.setFrequency(Math.round(mhz * 1_000_000));
        }
      }

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") {
          committed = true;
          if (input.parentNode) input.parentNode.removeChild(input);
          els.radioFrequencyDisplay.style.display = "";
          delete els.radioFrequencyDisplay.dataset.editing;
        }
      });

      // Delay blur listener so the browser settles focus before we watch for it
      setTimeout(() => {
        input.addEventListener("blur", commit, { once: true });
        input.focus();
        input.select();
      }, 50);
    }

    function adjustFrequencyByStep(stepHz) {
      const currentHz = cat.getStagedFrequency() || parseFrequencyText(cat.getFrequency());
      const nextHz = Math.max(0, (Number.isFinite(currentHz) ? currentHz : 0) + stepHz);
      void cat.setFrequency(nextHz);
    }

    function handleModeQuickSelect(event) {
      const button = event.target.closest("[data-mode-value]");
      if (!button) {
        return;
      }

      cat.setStagedMode(button.dataset.modeValue);
      syncRadioConsole();
      if (cat.isConnected()) {
        void cat.setMode();
      }
    }

    function renderModeOptions(profile) {
      // profile.modes is always cat.getModes()'s own current value here (profile
      // is RADIO_PROFILES[profileId] for the connector's own activeProfileId at
      // both call sites), so there's no separate activeModes field to set.
      renderModeQuickButtons(profile);
    }

    function renderModeQuickButtons(profile) {
      els.modeQuickGrid.innerHTML = profile.modes
        .map((mode) => {
          const display = digiDisplayLabel(mode.label) ?? mode.label;
          return `<button type="button" class="mode-chip${digiDisplayLabel(mode.label) ? " mode-chip-digi" : ""}" data-mode-value="${escapeHtml(mode.value)}" data-mode-label="${escapeHtml(mode.label)}">${escapeHtml(display)}</button>`;
        })
        .join("");
      syncRadioConsole();
    }

    function handleProfileChange() {
      cat.setProfile(els.radioProfile.value);
      applyProfileSettings(cat.getProfileId());
      applyCatOverrides();
      // seedQsoDefaults (logger) is handled by js/apps/logger/index.js
      // via its "radio-profile-changed" bus listener — see this file's header
      // note for why this dispatches instead of calling it directly.
      bus.dispatchEvent(new CustomEvent("radio-profile-changed"));
      updateRadioUi();
      persistCatSettings();
      appendSerialLog(`Switched CAT profile to ${cat.getProfile().name}.`);
    }

    // Build the rig picker from the catalogue itself. These options used to be
    // ~110 hardcoded <option> tags in index.html; now that RADIO_PROFILES is
    // generated from Hamlib, hardcoded markup would drift out of sync with it
    // on the very next --build (and after the Hamlib renumbering, would point
    // at ids the catalogue no longer defines).
    //
    // Grouped by the leading word of each profile name, which is the
    // manufacturer for every Hamlib-derived entry ("Yaesu FT-897"). The four
    // hand-written profiles have no manufacturer, so they sit ungrouped at the
    // top where the old markup also put "No Radio".
    function populateProfilePicker() {
      const select = els.radioProfile;
      if (!select) return;
      const UNGROUPED = new Set(["0", "1", "2", "4"]);
      const groups = new Map();
      const loose = [];
      for (const [id, profile] of Object.entries(RADIO_PROFILES)) {
        if (UNGROUPED.has(id)) { loose.push([id, profile]); continue; }
        const maker = (profile.name || "").split(" ")[0] || "Other";
        if (!groups.has(maker)) groups.set(maker, []);
        groups.get(maker).push([id, profile]);
      }
      const option = ([id, p]) =>
        `<option value="${escapeHtml(id)}">${escapeHtml(p.name)}</option>`;
      const html = [
        ...loose.map(option),
        ...[...groups.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([maker, entries]) =>
            `<optgroup label="${escapeHtml(maker)}">${entries.map(option).join("")}</optgroup>`),
      ].join("");
      select.innerHTML = html;
    }

    function applyProfileSettings(profileId) {
      const profile = RADIO_PROFILES[profileId];
      if (!profile) {
        return;
      }

      els.radioProfile.value = profileId;

      // The rigctld profiles talk over a WebSocket bridge, not a serial port,
      // so the serial settings are meaningless for them and the bridge URL is
      // shown instead. Toggling here is what stops those profiles from
      // presenting (and persisting) baud/parity/etc that never apply.
      const isBridge = profile.transport === "websocket";
      els.serialSettings.forEach((el) => { el.style.display = isBridge ? "none" : ""; });
      if (els.bridgeUrlLabel) els.bridgeUrlLabel.style.display = isBridge ? "block" : "none";
      if (isBridge && els.bridgeUrl) els.bridgeUrl.value = cat.getBridgeUrl();

      if (profile.protocol !== "none" && !isBridge) {
        els.baudRate.value = String(profile.serial.baudRate);
        els.dataBits.value = String(profile.serial.dataBits);
        els.stopBits.value = String(profile.serial.stopBits);
        els.parity.value = profile.serial.parity;
        els.flowControl.value = profile.serial.flowControl;
      }

      if (profile.protocol === "icom-civ") {
        els.civAddrLabel.style.display = "block";
        els.civAddress.value = (profile.civAddr || 0).toString(16).toUpperCase().padStart(2, "0");
      } else {
        els.civAddrLabel.style.display = "none";
      }

      renderModeOptions(profile);
    }

    function persistCatSettings() {
      cat.persistSettings({
        profileId: cat.getProfileId(),
        baudRate: els.baudRate.value,
        dataBits: els.dataBits.value,
        stopBits: els.stopBits.value,
        parity: els.parity.value,
        flowControl: els.flowControl.value,
        civAddress: els.civAddress.value
      });
    }

    function applyCatOverrides() {
      const saved = cat.applyOverrides(cat.getProfileId());
      if (!saved) {
        return;
      }
      if (saved.baudRate) els.baudRate.value = saved.baudRate;
      if (saved.dataBits) els.dataBits.value = saved.dataBits;
      if (saved.stopBits) els.stopBits.value = saved.stopBits;
      if (saved.parity) els.parity.value = saved.parity;
      if (saved.flowControl) els.flowControl.value = saved.flowControl;
      if (saved.civAddress) els.civAddress.value = saved.civAddress;
    }

    // Derive the band chip + hidden band input from the Frequency field.
    function updateFreqBandChip() {
      if (!els.frequencyInput) return;
      const hz = parseFrequencyText(els.frequencyInput.value || "");
      const band = hz ? inferBandFromFrequency(hz) : "";
      if (els.bandInput) els.bandInput.value = band;
      if (els.freqBandChip) {
        els.freqBandChip.textContent = band || "—";
        els.freqBandChip.dataset.empty = band ? "0" : "1";
      }
      if (els.bandQuickset) {
        els.bandQuickset.querySelectorAll("[data-qs-band]").forEach((btn) => {
          btn.classList.toggle("active", Boolean(band) && btn.dataset.qsBand === band);
        });
      }
    }

    // Band quick-set strip is visible only while the frequency field (or the
    // strip itself) has focus; focusout fires before the new element receives
    // focus, so relatedTarget tells us whether focus stayed inside the group.
    function bindFreqQuickset() {
      const wrap = els.frequencyInput?.closest("label")?.parentElement;
      if (!wrap || !els.bandQuickset) return;
      const group = [els.frequencyInput.closest("label"), els.bandQuickset];
      const inGroup = (node) => group.some((g) => g && node instanceof Node && g.contains(node));
      const show = () => { els.bandQuickset.hidden = false; };
      const hide = (event) => {
        if (inGroup(event.relatedTarget)) return;
        els.bandQuickset.hidden = true;
      };
      group.forEach((g) => {
        g.addEventListener("focusin", show);
        g.addEventListener("focusout", hide);
      });
      els.bandQuickset.querySelectorAll("[data-qs-band]").forEach((btn) => {
        btn.addEventListener("click", () => {
          cat.setFreqFollow(false);
          els.frequencyInput.value = btn.dataset.qsMhz;
          updateFreqBandChip();
          els.frequencyInput.focus();
        });
      });
      els.freqRadioChip?.addEventListener("click", () => {
        cat.setFreqFollow(true);
        syncRadioConsole();
        els.frequencyInput.focus();
      });
      els.frequencyInput.addEventListener("input", () => {
        cat.setFreqFollow(false);
        updateFreqBandChip();
        // updateDupeBanner (logger) is handled by js/apps/logger/index.js
        // via its "dupe-banner-refresh" bus listener — see this file's header note.
        bus.dispatchEvent(new CustomEvent("dupe-banner-refresh"));
      });
    }

    // highlight the mode quick-set button
    // matching the current Mode field value. Mirrors updateFreqBandChip.
    function updateModeQuickButtons() {
      if (!els.modeQuickset) return;
      const val = (els.modeInput?.value || "").trim().toUpperCase();
      els.modeQuickset.querySelectorAll("[data-qs-mode]").forEach((btn) => {
        btn.classList.toggle("active", Boolean(val) && btn.dataset.qsMode.toUpperCase() === val);
      });
    }

    // mode quick-set strip — same focus-group
    // show/hide and radio-follow pattern as bindFreqQuickset above, but for
    // popular ham modes instead of bands.
    function bindModeQuickset() {
      const wrap = els.modeInput?.closest("label")?.parentElement;
      if (!wrap || !els.modeQuickset) return;
      const group = [els.modeInput.closest("label"), els.modeQuickset];
      const inGroup = (node) => group.some((g) => g && node instanceof Node && g.contains(node));
      const show = () => { els.modeQuickset.hidden = false; };
      const hide = (event) => {
        if (inGroup(event.relatedTarget)) return;
        els.modeQuickset.hidden = true;
      };
      group.forEach((g) => {
        g.addEventListener("focusin", show);
        g.addEventListener("focusout", hide);
      });
      els.modeQuickset.querySelectorAll("[data-qs-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          cat.setModeFollow(false);
          els.modeInput.value = btn.dataset.qsMode;
          updateModeQuickButtons();
          els.modeInput.focus();
        });
      });
      els.modeRadioChip?.addEventListener("click", () => {
        cat.setModeFollow(true);
        syncRadioConsole();
        els.modeInput.focus();
      });
      els.modeInput.addEventListener("input", () => {
        cat.setModeFollow(false);
        updateModeQuickButtons();
      });
    }

    function updateMissionDashboard() {
      if (els.whSumUtc) {
        els.whSumUtc.textContent = new Date().toISOString().slice(11, 19);
      }
      const hz = parseFrequencyText(cat.getFrequency()) || cat.getStagedFrequency();
      const mhz = Number.isFinite(hz) ? hz / 1_000_000 : NaN;
      if (els.whSumBand) {
        els.whSumBand.textContent = mhzToBandName(mhz);
      }
      const grid = (ctx.settings.get().ft8MyGrid || "").trim().toUpperCase();
      if (els.whSumGrid) {
        els.whSumGrid.textContent = grid || "—";
      }
      const cutoff = Date.now() - 60_000;
      const decodeCount = ctx.ft8?.pruneDecodeTimestamps(cutoff) ?? 0;
      if (els.whSumDecodes) {
        els.whSumDecodes.textContent = String(decodeCount);
      }
      // the sidebarFootStatus write that used to sit here moved to
      // js/shell/shell.js's updateSidebarSmeter(), which listens for cat
      // "status" directly instead of this function's 1s interval.
    }

    async function sendCwMacro() {
      if (!cat.isConnected()) {
        appendSerialLog("Connect a radio before sending CW.");
        return;
      }

      if (ctx.ft8?.txInProgress) {
        appendSerialLog("FT8 TX is active. Abort FT8 transmission before keying CW.");
        return;
      }

      const text = els.cwMacroText.value.trim().toUpperCase();
      if (!text) {
        appendSerialLog("Enter CW text to key.");
        return;
      }

      const unsupported = [...new Set(text.replace(/\s+/g, "").split("").filter((char) => !CW_MORSE_MAP[char]))];
      if (unsupported.length) {
        appendSerialLog(`CW macro has unsupported characters: ${unsupported.join(" ")}`);
        return;
      }

      const wpm = Number.parseInt(els.cwMacroWpm.value, 10);
      if (!Number.isFinite(wpm) || wpm < 5 || wpm > 60) {
        appendSerialLog("CW speed must be between 5 and 60 WPM.");
        return;
      }

      const ditMs = Math.round(1200 / wpm);
      const originalPttState = cat.getPtt();
      cwMacroInProgress = true;
      updateRadioUi();
      appendSerialLog(`CW macro started (${wpm} WPM): ${text}`);

      try {
        const profile = cat.getProfile();
        const protocol = profile.protocol;
        appendSerialLog(`Sending CW via ${protocol}: ${text}`);

        switch (protocol) {
          case "kenwood-ascii":
          case "yaesu-ascii":
          case "elecraft-ascii":
          case "flex-ascii":
            // Most radios require PTT ON for KY, but some handle it automatically.
            // We'll keep cat.setPtt(true) wrapper from outside if needed,
            // but for KY it's usually better to just send the text.
            await cat.sendCommand(`KY${text};`, "CW Keyer (KY)");
            break;
          case "icom-civ":
            // 0x17 is the CW send command for Icom
            const textBytes = new TextEncoder().encode(text);
            await cat.sendCommand(buildCivPacket(0x17, 0x00, Array.from(textBytes)), "CW Keyer (0x17)");
            break;
          case "yaesu-5byte":
            appendSerialLog("CAT CW keying is not supported for Yaesu 5-byte radios. Please use hardware keying.");
            break;
          default:
            appendSerialLog(`CW keying not implemented for protocol: ${protocol}`);
            break;
        }

        appendSerialLog("CW macro completed.");
      } catch (error) {
        appendSerialLog(`CW macro failed: ${error.message}`);
      } finally {
        cwMacroInProgress = false;
        try {
          await cat.setPtt(originalPttState);
        } catch (error) {
          appendSerialLog(`PTT restore failed after CW macro: ${error.message}`);
        }
        updateRadioUi();
      }
    }

    // ====== Wiring ======
    els.connectBtn?.addEventListener("click", cat.connect);
    els.reconnectBtn?.addEventListener("click", cat.reconnect);
    els.disconnectBtn?.addEventListener("click", cat.disconnect);
    els.radioProfile?.addEventListener("change", handleProfileChange);
    els.radioFrequencyDisplay?.addEventListener("click", startInlineFrequencyEdit);
    els.sendCwMacroBtn?.addEventListener("click", () => { void sendCwMacro(); });
    els.pttBtn?.addEventListener("click", () => { void cat.togglePtt(); });
    els.stepButtons.forEach((button) =>
      button.addEventListener("click", () => adjustFrequencyByStep(Number(button.dataset.stepHz)))
    );
    els.modeQuickGrid?.addEventListener("click", handleModeQuickSelect);
    [els.baudRate, els.dataBits, els.stopBits, els.parity, els.flowControl, els.civAddress].forEach((el) => {
      el?.addEventListener("change", persistCatSettings);
    });
    // The bridge URL is CAT config but lives under its own storage key (it is
    // not part of the serial-override blob persistCatSettings writes), so it
    // saves through the connector's own setter on edit.
    els.bridgeUrl?.addEventListener("change", () => cat.setBridgeUrl(els.bridgeUrl.value));

    cat.addEventListener("frequency", (e) => updateFrequencyDisplay(e.detail));
    cat.addEventListener("mode", () => updateRadioUi());
    cat.addEventListener("status", () => { updateRadioUi(); syncRadioConsole(); });
    cat.addEventListener("ptt", () => updateRadioUi());
    cat.addEventListener("serial-log", (e) => appendSerialLog(e.detail));

    // Own "pota" listener for this app's rendering —
    // js/apps/spots/index.js's own listener
    // keeps only the status text it sets before spots.fetchPotaSpots()
    // resolves — see this file's header note.
    spots.addEventListener("pota", (e) => {
      const { spots: spotArr, error } = e.detail;
      els.potaStatus.textContent = error
        ? "Spots Unavailable"
        : (spotArr.length ? `${spotArr.length} Live Spots` : "No Live Spots");
      updateMissionDashboard();
      appendSerialLog(error
        ? `POTA spot refresh failed: ${error.message}`
        : `Loaded ${spotArr.length} live POTA spot${spotArr.length === 1 ? "" : "s"}.`);
    });
    spots.addEventListener("log", (e) => appendSerialLog(e.detail));
    audio.addEventListener("log", (e) => appendSerialLog(e.detail));

    // js/apps/ft8/index.js and js/apps/logger/index.js each keep thin
    // appendSerialLog/updateFreqBandChip/syncRadioConsole locals (many
    // FT8/logger call sites still use those names) that dispatch these bus
    // events instead of duplicating the real bodies above — see this file's
    // header note.
    // The bus "serial-log" forwarder that used to sit here is gone: FT8 and the
    // logger write the shared strip directly now (js/serial-log.js), so a log
    // line no longer depends on this app having mounted.
    bus.addEventListener("freq-band-chip-refresh", () => updateFreqBandChip());
    bus.addEventListener("mode-quickset-refresh", () => updateModeQuickButtons());
    bus.addEventListener("radio-console-sync", () => syncRadioConsole());

    if (els.serialSupportStatus) {
      els.serialSupportStatus.textContent = ("serial" in navigator) ? "Available" : "Not supported";
    }

    bindFreqQuickset();
    bindModeQuickset();
    // Must precede applyProfileSettings: that sets select.value, which silently
    // does nothing while the <select> is still empty.
    populateProfilePicker();
    applyProfileSettings(cat.getProfileId());
    applyCatOverrides();
    updateFreqBandChip();
    updateModeQuickButtons();
    updateRadioUi();
    // Once a second for the life of the page. Nothing here is visible while the
    // document is hidden, so skip the DOM writes and the decode-timestamp prune
    // until it comes back — a backgrounded tab should be idle, not busy.
    window.setInterval(() => {
      if (document.hidden) return;
      updateMissionDashboard();
    }, 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateMissionDashboard();
    });
    updateMissionDashboard();
  }
};
