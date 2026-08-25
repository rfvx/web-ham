// Settings connector — localStorage-backed store for app settings, plus the
// shared KEYS map of localStorage key names used across the app.
// Consumes: nothing (localStorage only).

export const KEYS = {
  SETTINGS_KEY: "web-ham-logger.settings",
  CAT_SETTINGS_KEY: "web-ham-logger.cat-settings",
  LOGBOOKS_KEY: "web-ham-logger.logbooks",
  ACTIVE_LOGBOOK_KEY: "web-ham-logger.active-logbook",
  PANEL_COLLAPSE_KEY: "web-ham-logger.panel-collapse",
  FT8_COLORS_KEY: "web-ham-logger.ft8-colors",
  AUDIO_DEVICE_CONFIG_KEY: "web-ham-logger.audio-device-config",
  LOTW_P12_KEY: "web-ham-logger.lotw-p12",
};

// The LoTW station certificate (.p12) and all account passwords are no longer
// stored here in plaintext — they live encrypted at rest in secure-store.js
// (getLotwP12Meta / getSecret there). KEYS.LOTW_P12_KEY is retained only so the
// secure store's one-time migration can find and strip any legacy plaintext.

export const settings = Object.assign(new EventTarget(), {
  get() {
    try {
      return JSON.parse(localStorage.getItem(KEYS.SETTINGS_KEY) || "{}");
    } catch {
      return {};
    }
  },
  // `silent: true` skips the automatic "change" dispatch — for callers that
  // need to finish their own DOM writes (e.g. normalizing form fields) before
  // the "change" listener re-renders from that DOM state, so the listener
  // never observes a stale/pre-normalization value. See js/apps/settings/
  // index.js saveSettings()/clearSettings() for the one caller that uses this.
  set(next, { silent = false } = {}) {
    localStorage.setItem(KEYS.SETTINGS_KEY, JSON.stringify(next));
    if (!silent) this.dispatchEvent(new CustomEvent("change", { detail: next }));
  },
  clear({ silent = false } = {}) {
    localStorage.removeItem(KEYS.SETTINGS_KEY);
    if (!silent) this.dispatchEvent(new CustomEvent("change", { detail: {} }));
  },
});
