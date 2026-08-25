// Settings mini-app — station identity, lookup and LoTW accounts, audio routing
// preferences, theme, and the reset action.
//
// Constraints worth knowing before changing anything here:
//
// - The settings connector is the single source of truth for values other apps
//   read (ft8MyCall, ft8MyGrid, stationCall). This app persists a few FT8 inputs
//   live on input, which is why the FT8 tab's fields can be read from settings
//   rather than from that tab's DOM.
//
// - Passwords and the LoTW .p12 never go in the settings blob. They live
//   encrypted at rest in js/connectors/secure-store.js, and only the non-secret
//   fields round-trip through settings.get()/set().
//
// - It listens for secureStore "persist-failed" and shows it. A credential that
//   could not be written is otherwise invisible — the field accepts the value
//   and it is gone on reload, which is what happens on a plain http:// origin
//   where there is no WebCrypto.
//
// - Its own settings "change" listener handles only the FT8 preview refresh; the
//   shell has a separate listener that applies the theme. Both fire on every
//   change and touch disjoint DOM.
//
// - The .p12 file input is size-capped. The certificate is base64'd into the
//   encrypted blob in localStorage, so a wrong, large file would blow the quota
//   and take every other secret with it.

import { KEYS } from "../../connectors/settings.js";
import { getSecret, setSecret, getLotwP12Meta, setLotwP12Meta, clearSecrets, secureStore } from "../../connectors/secure-store.js";
import { normalizeThemePreference, bytesToBase64 } from "../../utils.js";
import { bus } from "../../bus.js";

// Base highlight color per decode category; tints are derived in CSS via
// color-mix. Only used by the FT8 color controls below.
const FT8_COLOR_DEFAULTS = {
  tome: "#4caf50",   // Calling you (my call in message)
  cq: "#f4d56b",     // CQ in message
  grid: "#ff8c00",   // New grid (not in log)
  worked: "#9aa0a6", // Worked before
  tx: "#ffd54a",     // Transmitted message
};

export default {
  id: "settings",
  title: "Settings",
  // panelEl is intentionally unused: this app's elements span multiple
  // panels (e.g. #ft8-dx-call lives outside #tab-settings), so mount()
  // queries `document` directly instead of scoping to panelEl.
  mount(panelEl, ctx) {
    const { settings, audio } = ctx;

    let dirty = false;
    let selectedTheme = "system";
    let revealQrz = false;
    let revealHamqth = false;

    // Local element lookups (byte-identical selectors to the old shared
    // `els` object in the old monolith). els.ft8MyCall/ft8MyGrid/ft8DxCall/ft8DxGrid/
    // ft8SentReport/ft8ReceivedReport are deliberately NOT included here as
    // exclusive to this module — js/apps/ft8/index.js holds its own
    // references to them (other FT8-tab code reads/writes them), so this
    // app queries the same DOM nodes independently rather than sharing that
    // module's object.
    const els = {
      ft8MyCall: document.querySelector("#ft8-my-call"),
      ft8MyGrid: document.querySelector("#ft8-my-grid"),
      ft8DxCall: document.querySelector("#ft8-dx-call"),
      ft8DxGrid: document.querySelector("#ft8-dx-grid"),
      ft8SentReport: document.querySelector("#ft8-sent-report"),
      ft8ReceivedReport: document.querySelector("#ft8-received-report"),
      settingsQrzUser: document.querySelector("#settings-qrz-user"),
      settingsQrzPass: document.querySelector("#settings-qrz-pass"),
      settingsQrzReveal: document.querySelector("#settings-qrz-reveal"),
      settingsHamqthUser: document.querySelector("#settings-hamqth-user"),
      settingsHamqthPass: document.querySelector("#settings-hamqth-pass"),
      settingsHamqthReveal: document.querySelector("#settings-hamqth-reveal"),
      settingsLookupChip: document.querySelector("#settings-lookup-chip"),
      settingsStationCall: document.querySelector("#settings-station-call"),
      settingsAutoConnect: document.querySelector("#settings-auto-connect"),
      settingsShowSerial: document.querySelector("#settings-show-serial"),
      settingsPotaNotes: document.querySelector("#settings-pota-notes"),
      settingsPerAppAudio: document.querySelector("#settings-per-app-audio"),
      settingsAudioRoutingNote: document.querySelector("#settings-audio-routing-note-text"),
      saveSettingsBtn: document.querySelector("#save-settings-btn"),
      clearSettingsBtn: document.querySelector("#clear-settings-btn"),
      resetDangerBtn: document.querySelector("#settings-reset-danger-btn"),
      settingsSaveStatus: document.querySelector("#settings-save-status"),
      lotwSettingsUser: document.querySelector("#settings-lotw-user"),
      lotwSettingsPass: document.querySelector("#settings-lotw-pass"),
      lotwSettingsP12Pass: document.querySelector("#settings-lotw-p12-pass"),
      lotwP12Input: document.querySelector("#settings-lotw-p12-input"),
      lotwP12Name: document.querySelector("#settings-lotw-p12-name"),
    };

    function markDirty() {
      dirty = true;
      if (els.settingsSaveStatus) els.settingsSaveStatus.textContent = "Unsaved changes";
      if (els.saveSettingsBtn) {
        els.saveSettingsBtn.classList.remove("is-saved");
        els.saveSettingsBtn.textContent = "Save settings";
      }
    }

    function markClean(statusText) {
      dirty = false;
      if (els.settingsSaveStatus) els.settingsSaveStatus.textContent = statusText;
      if (els.saveSettingsBtn) {
        els.saveSettingsBtn.classList.add("is-saved");
        els.saveSettingsBtn.textContent = "Saved";
      }
    }

    function updateLookupChip() {
      if (!els.settingsLookupChip) return;
      const on = !!(els.settingsQrzUser?.value.trim() || els.settingsHamqthUser?.value.trim());
      els.settingsLookupChip.textContent = on ? "Configured" : "Not set";
      els.settingsLookupChip.classList.toggle("on", on);
      els.settingsLookupChip.classList.toggle("off", !on);
    }

    // No UI reads this back (the Settings-page theme picker is gone — see the
    // header note); it exists only so saveSettings() can echo the current
    // theme into the blob it writes, rather than erasing it.
    function setSelectedTheme(pref) {
      selectedTheme = normalizeThemePreference(pref);
    }

    function getFt8Colors() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEYS.FT8_COLORS_KEY) || "{}"); } catch { saved = {}; }
      return { ...FT8_COLOR_DEFAULTS, ...saved };
    }

    function applyFt8Colors(colors = getFt8Colors()) {
      const root = document.documentElement;
      for (const key of Object.keys(FT8_COLOR_DEFAULTS)) {
        root.style.setProperty(`--ft8-hl-${key}`, colors[key] || FT8_COLOR_DEFAULTS[key]);
      }
    }

    function updateFt8ColorValueReadout(key, value) {
      const readout = document.querySelector(`.ft8-color-value[data-value-for="ft8-color-${key}"]`);
      if (readout) readout.textContent = value.toUpperCase();
    }

    function initFt8ColorControls() {
      const colors = getFt8Colors();
      applyFt8Colors(colors);
      for (const key of Object.keys(FT8_COLOR_DEFAULTS)) {
        const input = document.querySelector(`#ft8-color-${key}`);
        if (!input) continue;
        input.value = colors[key];
        updateFt8ColorValueReadout(key, colors[key]);
        input.addEventListener("input", () => {
          const next = getFt8Colors();
          next[key] = input.value;
          localStorage.setItem(KEYS.FT8_COLORS_KEY, JSON.stringify(next));
          applyFt8Colors(next);
          updateFt8ColorValueReadout(key, input.value);
        });
      }
      document.querySelector("#ft8-colors-reset")?.addEventListener("click", () => {
        localStorage.removeItem(KEYS.FT8_COLORS_KEY);
        applyFt8Colors();
        for (const key of Object.keys(FT8_COLOR_DEFAULTS)) {
          const input = document.querySelector(`#ft8-color-${key}`);
          if (input) input.value = FT8_COLOR_DEFAULTS[key];
          updateFt8ColorValueReadout(key, FT8_COLOR_DEFAULTS[key]);
        }
      });
    }

    function loadSettings() {
      const s = settings.get();
      els.ft8MyCall.value = s.ft8MyCall || "";
      els.ft8MyGrid.value = s.ft8MyGrid || "";
      els.ft8DxCall.value = s.ft8DxCall || "";
      els.ft8DxGrid.value = s.ft8DxGrid || "";
      els.ft8SentReport.value = s.ft8SentReport || "-10";
      els.ft8ReceivedReport.value = s.ft8ReceivedReport || "-12";
      els.settingsQrzUser.value = s.qrzUser || "";
      els.settingsQrzPass.value = getSecret("qrzPass");
      els.settingsHamqthUser.value = s.hamqthUser || "";
      els.settingsHamqthPass.value = getSecret("hamqthPass");
      els.settingsStationCall.value = s.stationCall || "";
      if (els.lotwSettingsUser) els.lotwSettingsUser.value = s.lotwUser || "";
      // Passwords + the .p12 are encrypted at rest (secure-store); they are
      // NOT in the settings blob. Read the decrypted values from the cache.
      if (els.lotwSettingsPass) els.lotwSettingsPass.value = getSecret("lotwPass");
      if (els.lotwSettingsP12Pass) els.lotwSettingsP12Pass.value = getSecret("lotwP12Pass");
      const p12Meta = getLotwP12Meta();
      if (els.lotwP12Name) els.lotwP12Name.textContent = p12Meta ? p12Meta.name : "No certificate attached";
      if (els.settingsAutoConnect) els.settingsAutoConnect.checked = s.autoConnect !== false;
      if (els.settingsShowSerial) els.settingsShowSerial.checked = !!s.showSerial;
      if (els.settingsPotaNotes) els.settingsPotaNotes.checked = s.potaNotes !== false;
      setSelectedTheme(s.theme);
      if (els.settingsPerAppAudio) {
        els.settingsPerAppAudio.checked = audio.getConfig().perAppMode;
        if (els.settingsAudioRoutingNote) {
          els.settingsAudioRoutingNote.textContent = audio.getConfig().perAppMode
            ? "Each app now shows its own audio selectors."
            : "Set your shared devices in the top bar.";
        }
      }
      updateLookupChip();
      return s;
    }

    function saveSettings() {
      const s = {
        ft8MyCall: els.ft8MyCall.value.trim().toUpperCase(),
        ft8MyGrid: els.ft8MyGrid.value.trim().toUpperCase(),
        ft8DxCall: els.ft8DxCall.value.trim().toUpperCase(),
        ft8DxGrid: els.ft8DxGrid.value.trim().toUpperCase(),
        ft8SentReport: els.ft8SentReport.value.trim() || "-10",
        ft8ReceivedReport: els.ft8ReceivedReport.value.trim() || "-12",
        qrzUser: els.settingsQrzUser.value.trim(),
        hamqthUser: els.settingsHamqthUser.value.trim(),
        stationCall: els.settingsStationCall.value.trim().toUpperCase(),
        lotwUser: els.lotwSettingsUser?.value.trim() || "",
        autoConnect: !!els.settingsAutoConnect?.checked,
        showSerial: !!els.settingsShowSerial?.checked,
        potaNotes: !!els.settingsPotaNotes?.checked,
        theme: selectedTheme
      };
      // Secrets are persisted encrypted, never in the settings blob above.
      setSecret("qrzPass", els.settingsQrzPass.value);
      setSecret("hamqthPass", els.settingsHamqthPass.value);
      setSecret("lotwPass", els.lotwSettingsPass?.value || "");
      setSecret("lotwP12Pass", els.lotwSettingsP12Pass?.value || "");
      // Review fix: set() is silent here so the
      // connector's dispatch doesn't fire until AFTER the DOM-normalization
      // writes below (e.g. blank "Received Report" -> "-12"). Otherwise
      // the settings "change" listener (this app's own, forwarding to
      // js/apps/ft8/index.js's FT8 preview via bus "ft8-preview-refresh" —
      // see header note) would re-render the FT8 preview from the
      // pre-normalization DOM values one tick too early. See
      // js/connectors/settings.js set() and "Review fix".
      settings.set(s, { silent: true });
      els.ft8MyCall.value = s.ft8MyCall;
      els.ft8MyGrid.value = s.ft8MyGrid;
      els.ft8DxCall.value = s.ft8DxCall;
      els.ft8DxGrid.value = s.ft8DxGrid;
      els.ft8SentReport.value = s.ft8SentReport;
      els.ft8ReceivedReport.value = s.ft8ReceivedReport;
      updateLookupChip();
      markClean("✓ Settings saved.");
      setTimeout(() => {
        if (els.settingsSaveStatus && els.settingsSaveStatus.textContent === "✓ Settings saved.") {
          els.settingsSaveStatus.textContent = "Ready";
        }
      }, 2500);
      settings.dispatchEvent(new CustomEvent("change", { detail: s }));
    }

    function clearSettings() {
      // Review fix: clear() is silent so the connector's
      // dispatch doesn't fire until AFTER loadSettings() resets the form
      // fields to defaults. Otherwise the settings "change" listener (see
      // header note) would re-render the FT8 preview (e.g. target callsign)
      // from the still-stale DOM values before loadSettings() clears them.
      settings.clear({ silent: true });
      // Also drop every encrypted secret (passwords + .p12) on reset.
      clearSecrets();
      const s = loadSettings();
      markClean("Settings cleared — server defaults will be used.");
      setTimeout(() => {
        if (els.settingsSaveStatus && els.settingsSaveStatus.textContent === "Settings cleared — server defaults will be used.") {
          els.settingsSaveStatus.textContent = "Ready";
        }
      }, 3000);
      settings.dispatchEvent(new CustomEvent("change", { detail: s }));
    }

    // A LoTW station certificate is a few KB. The cap is generous enough for any
    // real .p12 and exists to catch the wrong file being picked: the certificate
    // is base64'd into localStorage via the encrypted secret blob, so a
    // multi-megabyte file would blow the storage quota and take every other
    // secret down with it — and the failure surfaced only as a console warning.
    const MAX_P12_BYTES = 512 * 1024;

    async function attachLotwP12(event) {
      const [file] = event.target.files || [];
      if (!file) return;
      const setName = (text) => { if (els.lotwP12Name) els.lotwP12Name.textContent = text; };
      const clearInput = () => { if (els.lotwP12Input) els.lotwP12Input.value = ""; };
      try {
        if (file.size > MAX_P12_BYTES) {
          setName(`${file.name} is too large for a certificate (${Math.round(file.size / 1024)} KB) — not attached`);
          clearInput();
          return;
        }
        const buffer = await file.arrayBuffer();
        setLotwP12Meta({ name: file.name, data: bytesToBase64(new Uint8Array(buffer)) });
        setName(file.name);
      } catch (error) {
        // Was `void attachLotwP12(event)` with no catch, so a read failure or the
        // RangeError this used to throw on large files vanished into an unhandled
        // rejection while the UI showed the certificate as attached.
        console.error("[WebHam] LoTW certificate attach failed", error);
        setName("Couldn't read that certificate — try again");
      } finally {
        clearInput();
      }
    }

    // Left-rail category nav: clicking a .settings-nav-item marks it active and
    // shows its matching .settings-category panel, hiding the rest. Scoped to
    // #tab-settings — this app's elements are not all under one panelEl, but the
    // nav itself lives entirely inside that panel.
    // in the mini-app module, not inline markup.
    const navItems = document.querySelectorAll("#tab-settings .settings-nav-item");
    navItems.forEach((btn) => {
      btn.addEventListener("click", () => {
        navItems.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll("#tab-settings .settings-category").forEach((cat) => {
          cat.hidden = cat.dataset.category !== btn.dataset.category;
        });
      });
    });

    // #ft8-my-grid is a station-wide datum (the operator's Maidenhead grid),
    // not an FT8-only field: the Map, Satellites and Radio views need it too.
    // Persist it to settings live on every edit — silent, so the connector's
    // "change" -> re-render loop doesn't fight the caret — so those views can
    // read settings.get().ft8MyGrid as the single source of truth instead of
    // reaching across into this tab's DOM. saveSettings() still writes it (and
    // the rest of the form) on an explicit Save; this just keeps the persisted
    // value current between saves. See js/apps/{map,satellites,radio}/index.js.
    els.ft8MyGrid?.addEventListener("input", () => {
      settings.set({ ...settings.get(), ft8MyGrid: els.ft8MyGrid.value.trim().toUpperCase() }, { silent: true });
      markDirty();
    });
    els.ft8MyCall?.addEventListener("input", () => {
      markDirty();
    });

    els.saveSettingsBtn?.addEventListener("click", () => { if (dirty) saveSettings(); });
    els.clearSettingsBtn?.addEventListener("click", clearSettings);
    els.resetDangerBtn?.addEventListener("click", clearSettings);
    els.lotwP12Input?.addEventListener("change", (event) => { void attachLotwP12(event); });

    // A credential that could not be written to disk used to fail with nothing
    // but a console.warn — the operator typed a password, saw it accepted, and
    // found it gone after a reload. The commonest cause is the page being served
    // over plain http:// (not a secure context, so no WebCrypto), which is
    // exactly the case worth naming rather than leaving to be discovered.
    secureStore.addEventListener("persist-failed", (e) => {
      if (els.settingsSaveStatus) els.settingsSaveStatus.textContent = `⚠ ${e.detail}`;
    });

    els.settingsQrzReveal?.addEventListener("click", () => {
      revealQrz = !revealQrz;
      els.settingsQrzPass.type = revealQrz ? "text" : "password";
      els.settingsQrzReveal.textContent = revealQrz ? "Hide" : "Show";
    });
    els.settingsHamqthReveal?.addEventListener("click", () => {
      revealHamqth = !revealHamqth;
      els.settingsHamqthPass.type = revealHamqth ? "text" : "password";
      els.settingsHamqthReveal.textContent = revealHamqth ? "Hide" : "Show";
    });

    // The first-run guide spotlights real controls in here — the Station
    // identity card, then the LoTW card — and they live in different categories,
    // only one of which is on screen at a time. It asks through the bus because
    // the shell owns no element inside this panel.
    bus.addEventListener("settings-show-category", (e) => {
      const btn = [...navItems].find((b) => b.dataset.category === e.detail);
      // Driven through the nav button's own handler rather than by setting
      // `hidden` directly, so the active-item styling stays in step.
      if (btn && !btn.classList.contains("active")) btn.click();
    });

    // Kept for anything that wants to drop the operator on the callsign field
    // rather than on the tab.
    bus.addEventListener("focus-station-identity", () => {
      // After the tab is actually showing: "activate-tab" is dispatched
      // immediately before this, and focusing a panel that is still hidden
      // does nothing.
      requestAnimationFrame(() => {
        els.settingsStationCall?.focus();
        els.settingsStationCall?.scrollIntoView({ block: "center" });
      });
    });

    // Forward the connector's "change" event to two "ft8-preview-refresh" bus
    // dispatches. The FT8 app listens and runs the real render pair once per
    // dispatch, so two dispatches drive both halves of its preview.
    settings.addEventListener("change", () => {
      bus.dispatchEvent(new CustomEvent("ft8-preview-refresh"));
      bus.dispatchEvent(new CustomEvent("ft8-preview-refresh"));
    });
    // live FT8
    // preview refresh, dirty-tracking and (for the lookup fields) the
    // Configured/Not set chip, as these settings-tab fields are edited.
    [els.settingsQrzUser, els.settingsHamqthUser, els.settingsQrzPass, els.settingsHamqthPass]
      .forEach((element) => element?.addEventListener("input", () => {
        updateLookupChip();
        markDirty();
        bus.dispatchEvent(new CustomEvent("ft8-preview-refresh"));
      }));
    [els.settingsStationCall, els.lotwSettingsUser, els.lotwSettingsPass, els.lotwSettingsP12Pass]
      .forEach((element) => element?.addEventListener("input", () => {
        markDirty();
        bus.dispatchEvent(new CustomEvent("ft8-preview-refresh"));
      }));
    [els.settingsAutoConnect, els.settingsShowSerial, els.settingsPotaNotes, els.settingsPerAppAudio]
      .forEach((element) => element?.addEventListener("change", markDirty));

    // Boot-order note: this call moved from the monolith's early synchronous
    // init() (pre-Task-10) to mount() time. That's safe only because
    // styles.css declares matching `--ft8-hl-*` custom-property fallbacks
    // (e.g. `var(--ft8-hl-tome, #4caf50)`), so any FT8 waterfall/message
    // rendering that runs before this call still gets a correct color even
    // though the JS-set override hasn't been applied yet.
    initFt8ColorControls();
    const s = loadSettings();
    markClean("Ready");
    // Boot-time replay of the seam described above: this is the one path
    // where settings changed (were loaded) without going through
    // settings.set()/clear(), so nothing would otherwise notify
    // js/shell/shell.js / js/apps/ft8/index.js's listeners to run the theme +
    // FT8 preview refresh.
    settings.dispatchEvent(new CustomEvent("change", { detail: s }));
  }
};
