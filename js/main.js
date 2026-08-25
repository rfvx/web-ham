// WebHam entry point, and the definition of the mini-app contract.
//
// ── The contract ────────────────────────────────────────────────────────────
//
// A mini-app is a module whose default export is:
//
//   { id, title, mount(panelEl, ctx) }
//
//   id       matches its panel element `#tab-<id>` AND its entry in shell.js's
//            VIEW_ORDER/VIEWS (mountShell console.asserts the second half).
//   title    human label; shell.js currently owns the displayed name.
//   mount()  called exactly once, synchronously, after the shell has built the
//            page. There is no unmount: apps live for the document's lifetime,
//            so listeners they register are never removed. Anything that must
//            stop when a tab closes has to watch for that itself — closing a tab
//            moves its panel to the pool, it does not tear the app down.
//
// `ctx` is the connector context: the long-lived, DOM-free objects that own
// state and talk to hardware or the network — cat, audio, logbook, spots,
// lookup, settings, rotator — plus `bus` for app-to-app events. Connectors are
// EventTargets; apps subscribe rather than poll.
//
// Apps may also publish a capability onto ctx for other apps to use — today
// `ctx.ft8` and `ctx.logger`. Two rules make that safe, and both are load-
// bearing rather than stylistic:
//   1. Publish it as the FIRST statement of mount(), before any DOM work, so an
//      app mounted later in the loop can see it.
//   2. Read it lazily and optionally (`ctx.ft8?.x`) at event time, never captured
//      into a local at mount time — the publisher may mount after the consumer,
//      and the values behind it are re-assigned as sessions start and stop.
//
// Anything a connector needs must NOT come from an app. See js/vendor.js for the
// one place that rule was broken and what it cost.
//
// ── Boot order ──────────────────────────────────────────────────────────────
//
// mountShell(apps, ctx) builds the pane-tab-manager layout and binds shell-level
// chrome; it is synchronous, so the mount loop below provably runs after the
// page exists. (It used to be async and called without `await`, with the loop
// relying on the gap opened by its first `await` — correct only for as long as
// that await stayed the last statement in the function.)
import { cat } from "./connectors/cat.js";
import { audio } from "./connectors/audio.js";
import { logbook } from "./connectors/logbook.js";
import { spots } from "./connectors/spots.js";
import { lookup } from "./connectors/lookup.js";
import { settings } from "./connectors/settings.js";
import { initSecureStore } from "./connectors/secure-store.js";
import { rotator } from "./connectors/rotator.js";
import { bus } from "./bus.js";
import { mountShell } from "./shell/shell.js";
import settingsApp from "./apps/settings/index.js";
import audioMacrosApp from "./apps/audio-macros/index.js";
import satellitesApp from "./apps/satellites/index.js";
import spotsApp from "./apps/spots/index.js";
import mapApp from "./apps/map/index.js";
import radioApp from "./apps/radio/index.js";
import loggerApp from "./apps/logger/index.js";
import ft8App from "./apps/ft8/index.js";
import sstvApp from "./apps/sstv/index.js";

// Apps may also register their own capabilities on ctx after mount (e.g.
// ft8 -> ctx.ft8, logger -> ctx.logger) for other apps to read lazily.
const ctx = { cat, audio, logbook, spots, lookup, settings, rotator, bus };

const apps = [settingsApp, audioMacrosApp, satellitesApp, spotsApp, mapApp, radioApp, loggerApp, ft8App, sstvApp]; // each app task appends here

// Decrypt credentials into the in-memory secret cache (and migrate any legacy
// plaintext off disk) BEFORE any app mounts — the settings app reads secrets in
// its loadSettings(), and lookup/logger read them on demand, all synchronously
// via getSecret(). Top-level await here holds boot until the cache is ready; it
// is one IndexedDB open + one AES-GCM decrypt, so the delay is negligible.
await initSecureStore();

mountShell(apps, ctx);

// Each app is mounted in isolation. Before this, one app throwing in mount()
// aborted the loop and every app after it in the array silently never mounted —
// so a typo in the FT8 app took out the logger, the map and settings, and the
// only clue was one console error. A mini-app system has to survive one broken
// mini-app; the panel for the failed app says so in place, rather than sitting
// blank and looking like a rendering bug.
for (const app of apps) {
  const panelEl = document.querySelector(`#tab-${app.id}`);
  if (!panelEl) {
    console.error(`[WebHam] no panel #tab-${app.id} for mini-app "${app.id}" — not mounted`);
    continue;
  }
  try {
    app.mount(panelEl, ctx);
  } catch (error) {
    console.error(`[WebHam] mini-app "${app.id}" failed to mount`, error);
    const notice = document.createElement("div");
    notice.className = "empty-state";
    notice.textContent = `${app.title || app.id} failed to load. The rest of WebHam is unaffected — see the browser console for details.`;
    panelEl.prepend(notice);
  }
}
