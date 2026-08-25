// Satellites mini-app — TLE fetch, pass prediction, live az/el telemetry, and
// Doppler-corrected tuning, plus the rotator connection.
//
// Constraints worth knowing before changing anything here:
//
// - Orbit maths comes from satellite.js, loaded as a classic script from cdnjs
//   in index.html (window.satellite). It is the one third-party script with no
//   Subresource Integrity — see the TODO at that tag.
//
// - TLEs come from /api/tle, a server-side proxy, because celestrak sends no
//   CORS headers. That endpoint exists on both server.js and Cloudflare Pages;
//   the Perl and PowerShell fallbacks do not implement it.
//
// - Doppler tuning stages frequencies through the cat connector, so it drives
//   whatever rig is connected without knowing which.
//
// - The rotator is a separate Web Serial port on its own connector. Its incoming
//   stream is drained and discarded; nothing parses position yet.
import { maidenheadToLatLon } from "../../grid.js";
import { buildYaesu5ByteFrequencyCommand } from "../../connectors/cat.js";
import { appendSerialLog } from "../../serial-log.js";

const SATELLITE_RADIO_FREQUENCIES = [
  { match: "ISS", rx: 145800000, tx: 145990000 }, // ISS FM Voice / APRS is 145.825 simplex
  { match: "SO-50", rx: 436795000, tx: 145850000 },
  { match: "AO-91", rx: 145960000, tx: 435250000 },
  { match: "FOX-1B", rx: 145960000, tx: 435250000 },
  { match: "AO-27", rx: 436795000, tx: 145850000 },
  { match: "PO-101", rx: 145900000, tx: 437500000 },
  { match: "DIWATA", rx: 145900000, tx: 437500000 },
  { match: "RS-44", rx: 436250000, tx: 145965000 }, // Linear transponder center
  { match: "IO-117", rx: 436795000, tx: 436795000 }, // GreenCube digipeater
  { match: "GREENCUBE", rx: 436795000, tx: 436795000 },
  { match: "AO-7", rx: 145950000, tx: 432150000 }, // Mode B center approx
  { match: "FO-29", rx: 435850000, tx: 145950000 }, // JAS-2
  { match: "CAS-4A", rx: 145870000, tx: 435220000 },
  { match: "CAS-4B", rx: 145925000, tx: 435280000 },
  { match: "XW-2", rx: 145675000, tx: 435040000 }
];

export default {
  id: "satellites",
  title: "Satellites",
  mount(panelEl, ctx) {
    const { cat, rotator, bus } = ctx;

    const els = {
      fetchTleBtn: panelEl.querySelector("#fetch-tle-btn"),
      satSelector: panelEl.querySelector("#sat-selector"),
      satTleStatus: panelEl.querySelector("#sat-tle-status"),
      satObserverGrid: panelEl.querySelector("#sat-observer-grid"),
      satAzimuth: panelEl.querySelector("#sat-azimuth"),
      satElevation: panelEl.querySelector("#sat-elevation"),
      satRange: panelEl.querySelector("#sat-range"),
      satVisibility: panelEl.querySelector("#sat-visibility"),
      satBaseDownlink: panelEl.querySelector("#sat-base-downlink"),
      satBaseUplink: panelEl.querySelector("#sat-base-uplink"),
      satShiftedDownlink: panelEl.querySelector("#sat-shifted-downlink"),
      satShiftedUplink: panelEl.querySelector("#sat-shifted-uplink"),
      satAutoTune: panelEl.querySelector("#sat-auto-tune"),
      satDopplerStatus: panelEl.querySelector("#sat-doppler-status"),
      connectRotatorBtn: panelEl.querySelector("#connect-rotator-btn"),
      disconnectRotatorBtn: panelEl.querySelector("#disconnect-rotator-btn"),
      rotatorStatus: panelEl.querySelector("#rotator-status"),
      rotatorAutoTrack: panelEl.querySelector("#rotator-auto-track"),
      rotatorRawOut: panelEl.querySelector("#rotator-raw-out"),
      // Shared element outside #tab-satellites — same dual-query pattern
      // js/apps/settings/index.js and js/apps/audio-macros/index.js use for
      // #ft8-my-call/#serial-log.
    };


    // ====== Sat-only state (was on the monolith's shared `state`) ======
    let satTles = {};
    let satSelectedId = null;
    let satTrackerTimerId = null;
    let satLastObserverGrid = "";
    let satAutoDopplerTune = false;
    let satRotatorAutoTrack = false;
    let satLastTunedDownlink;
    let satLastTunedUplink;
    let satLastWasVisible;

    // Mirrors the rotator connector's live writer state (previously read as
    // `state.satRotatorWriter` truthy) — see header note.
    let rotatorConnected = false;

    // Latches the "uplink not tuned" warning (see setRadioSplitFrequencies)
    // so it logs once per situation instead of once per ~1 Hz tracker tick —
    // at 436 MHz the >5 Hz drift guard trips almost every tick, which was
    // flooding #serial-log (~600-900 identical lines per pass). Reset
    // wherever the situation actually changes: tracker start/stop and
    // satellite selection (handleSatSelectionChange) or radio profile
    // (bus "radio-profile-changed") — a genuinely new situation should warn
    // again.
    let warnedNoUplinkTune = false;

    async function fetchSatTles() {
      els.fetchTleBtn.disabled = true;
      els.satTleStatus.textContent = "Fetching...";
      try {
        const response = await fetch("/api/tle");
        if (!response.ok) {
          let detail = `HTTP ${response.status}`;
          try { const json = await response.json(); detail = json.error || detail; } catch { /* non-JSON body */ }
          throw new Error(detail);
        }
        const contentType = response.headers.get("content-type") || "";
        // A page instead of TLE text means /api/tle never ran — offline, with the
        // service worker answering from the app shell, is the usual reason.
        if (contentType.includes("text/html")) throw new Error("Couldn't reach the TLE service — check your connection");
        const text = await response.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
        satTles = {};
        for (let i = 0; i < lines.length - 2; i += 3) {
          const name = lines[i].trim();
          const tle1 = lines[i + 1].trim();
          const tle2 = lines[i + 2].trim();
          if (tle1.startsWith("1 ") && tle2.startsWith("2 ")) {
            const satrec = window.satellite.twoline2satrec(tle1, tle2);
            satTles[name] = { name, tle1, tle2, satrec };
          }
        }

        els.satSelector.innerHTML = '<option value="">Select a Satellite...</option>';
        Object.keys(satTles).sort().forEach(name => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          els.satSelector.appendChild(option);
        });

        els.satSelector.disabled = false;
        els.satTleStatus.textContent = `${Object.keys(satTles).length} Sats Loaded`;
        appendSerialLog("Amateur TLEs successfully loaded via Celestrak.");
      } catch (error) {
        els.satTleStatus.textContent = "Error Loading TLEs";
        appendSerialLog(`Failed to fetch TLEs: ${error.message}`);
      } finally {
        els.fetchTleBtn.disabled = false;
      }
    }

    function handleSatSelectionChange(event) {
      satSelectedId = event.target.value;
      if (satTrackerTimerId) {
        window.clearInterval(satTrackerTimerId);
        satTrackerTimerId = null;
      }
      // New tracking context (tracker stopped, or about to restart for a
      // different satellite) — let the uplink-not-tuned warning fire again.
      warnedNoUplinkTune = false;
      els.satAutoTune.disabled = !satSelectedId;
      els.rotatorAutoTrack.disabled = !satSelectedId;
      if (!satSelectedId) {
        els.satAzimuth.textContent = "--°";
        els.satElevation.textContent = "--°";
        els.satRange.textContent = "-- km";
        els.satVisibility.textContent = "--";
        els.satDopplerStatus.textContent = "Idle";
        els.satBaseDownlink.value = "";
        els.satBaseUplink.value = "";
        return;
      }

      // Observer-grid fallback reads the operator grid from the settings
      // connector, not the
      // FT8 tab's DOM — see js/apps/settings/index.js.
      const opGrid = (ctx.settings.get().ft8MyGrid || "").trim().toUpperCase();
      if (!satLastObserverGrid && opGrid) {
        satLastObserverGrid = opGrid;
        els.satObserverGrid.value = satLastObserverGrid;
      }

      // Auto-populate frequencies if known
      const satNameUpper = satSelectedId.toUpperCase();
      const knownSat = SATELLITE_RADIO_FREQUENCIES.find(s => satNameUpper.includes(s.match));
      if (knownSat) {
        els.satBaseDownlink.value = String(knownSat.rx);
        els.satBaseUplink.value = String(knownSat.tx);
      } else {
        els.satBaseDownlink.value = "";
        els.satBaseUplink.value = "";
      }

      updateSatTelemetry();
      satTrackerTimerId = window.setInterval(updateSatTelemetry, 1000);
      appendSerialLog(`Tracking started for ${satSelectedId}`);
    }

    async function updateSatTelemetry() {
      if (!satSelectedId) return;
      const sat = satTles[satSelectedId];
      if (!sat || typeof window.satellite === "undefined") return;

      const userGrid = els.satObserverGrid.value.trim().toUpperCase() || satLastObserverGrid;
      if (!userGrid) {
        els.satVisibility.textContent = "No Grid";
        return;
      }

      let latlon;
      try {
        latlon = maidenheadToLatLon(userGrid);
      } catch {
        els.satVisibility.textContent = "Invalid Grid";
        return;
      }

      const observerGd = {
        longitude: window.satellite.degreesToRadians(latlon.longitude || latlon[1]),
        latitude: window.satellite.degreesToRadians(latlon.latitude || latlon[0]),
        height: 0.050
      };

      const now = new Date();
      const positionAndVelocity = window.satellite.propagate(sat.satrec, now);
      if (!positionAndVelocity.position || !positionAndVelocity.velocity) {
        els.satVisibility.textContent = "Orbit Error";
        return;
      }

      const gmst = window.satellite.gstime(now);
      const positionEcf = window.satellite.eciToEcf(positionAndVelocity.position, gmst);
      const lookAngles = window.satellite.ecfToLookAngles(observerGd, positionEcf);

      const azimuth = window.satellite.radiansToDegrees(lookAngles.azimuth);
      const elevation = window.satellite.radiansToDegrees(lookAngles.elevation);
      const range = lookAngles.rangeSat;

      els.satAzimuth.textContent = `${azimuth.toFixed(1)}°`;
      els.satElevation.textContent = `${elevation.toFixed(1)}°`;
      els.satRange.textContent = `${range.toFixed(0)} km`;

      const visible = elevation >= 0;
      els.satVisibility.textContent = visible ? "Visible (AOS)" : "Below Horizon (LOS)";

      const velocityEcf = window.satellite.eciToEcf(positionAndVelocity.velocity, gmst);
      const rangeRate = calculateSatRangeRate(positionEcf, velocityEcf, observerGd);
      const dopplerFactor = 1 - (rangeRate / 299792.458);

      const baseDownlink = parseFloat(els.satBaseDownlink.value || "0");
      const baseUplink = parseFloat(els.satBaseUplink.value || "0");

      let shiftedDownlink = baseDownlink;
      let shiftedUplink = baseUplink;

      els.satDopplerStatus.textContent = visible ? `Doppler Factor: ${dopplerFactor.toFixed(6)}` : "Idle";

      if (baseDownlink > 0) {
        shiftedDownlink = Math.round(baseDownlink * dopplerFactor);
        els.satShiftedDownlink.textContent = `${Math.round(shiftedDownlink).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Hz`;
      }
      if (baseUplink > 0) {
        shiftedUplink = Math.round(baseUplink / dopplerFactor);
        els.satShiftedUplink.textContent = `${Math.round(shiftedUplink).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Hz`;
      }

      if (satAutoDopplerTune && cat.isConnected()) {
        const lastDownlink = satLastTunedDownlink || 0;
        const lastUplink = satLastTunedUplink || 0;

        if (Math.abs(shiftedDownlink - lastDownlink) > 5 || Math.abs(shiftedUplink - lastUplink) > 5) {
          satLastTunedDownlink = shiftedDownlink;
          satLastTunedUplink = shiftedUplink;
          void setRadioSplitFrequencies(shiftedDownlink, shiftedUplink);
        }
      }

      if (satRotatorAutoTrack && rotatorConnected) {
        const azStr = azimuth.toFixed(1).padStart(5, '0');
        const elStr = Math.max(0, elevation).toFixed(1).padStart(4, '0');
        const cmd = `AZ${azStr} EL${elStr}\r\n`;
        els.rotatorRawOut.value = cmd.trim();
        if (visible || satLastWasVisible) {
          void rotator.send(cmd);
        }
        satLastWasVisible = visible;
      }
    }

    function calculateSatRangeRate(satEcf, satVelEcf, observerGd) {
      const observerEcf = window.satellite.geodeticToEcf(observerGd);
      const rx = satEcf.x - observerEcf.x;
      const ry = satEcf.y - observerEcf.y;
      const rz = satEcf.z - observerEcf.z;
      const range = Math.sqrt(rx*rx + ry*ry + rz*rz);

      const vx = satVelEcf.x;
      const vy = satVelEcf.y;
      const vz = satVelEcf.z;

      return (rx*vx + ry*vy + rz*vz) / range;
    }

    // Sat-specific sequencing over ctx.cat calls — stays app-side per the
    // task brief. See header note on the updateFrequencyDisplay() seam and
    // the yaesu-5byte/buildFrequencyCommand() fix.
    //
    // NOTE: the `profile.id === "kenwood"` and `profile.id === "smartsdr-
    // smartcat"` branches below have the same dead-condition shape the
    // yaesu-5byte branch had (RADIO_PROFILES ids are numeric, never these
    // family-name strings — see js/connectors/cat.js), so in practice every
    // profile including real Kenwood/FlexRadio rigs falls through to the
    // generic ASCII `else` branch today. That predates this fix and is out
    // of scope for it (untested behavior change on hardware this fix can't
    // verify); left as-is, flagged here for follow-up triage.
    async function setRadioSplitFrequencies(downlinkHz, uplinkHz) {
      const profile = cat.getProfile();

      if (profile.id === "kenwood") {
        // NOTE: like the smartsdr-smartcat branch below, `profile.id ===
        // "kenwood"` is also a dead guard (RADIO_PROFILES ids are numeric —
        // see header note above), so this branch is currently unreachable
        // too. Not fixed here — out of scope, see header note.
        if (downlinkHz > 0) await cat.sendCommand(`FA${String(downlinkHz).padStart(11, "0")};`, `CAT Rx A`);
        if (uplinkHz > 0) await cat.sendCommand(`FB${String(uplinkHz).padStart(11, "0")};`, `CAT Tx B`);
      } else if (profile.id === "smartsdr-smartcat") {
        if (downlinkHz > 0) await cat.sendCommand(`ZZFA${String(downlinkHz).padStart(11, "0")};`, `CAT Rx A`);
        // TX VFO is built from `uplinkHz` (previously read `downlinkHz` — a
        // latent transmit-frequency bug, defused here so it can't spring when
        // the guard is repaired). NOTE the guard itself is still dead:
        // `profile.id === "smartsdr-smartcat"` never matches (RADIO_PROFILES
        // ids are numeric strings, e.g. "1023" — see js/connectors/cat.js), so
        // this whole branch is unreachable. Activating it — and the Kenwood
        // branch above — means sending untested CAT tune commands to a real
        // transceiver, which needs hardware verification, not just a guard fix.
        if (uplinkHz > 0) await cat.sendCommand(`ZZFB${String(uplinkHz).padStart(11, "0")};`, `CAT Tx B`);
      } else if (profile.protocol === "yaesu-5byte") {
        if (downlinkHz > 0) await cat.sendCommand(buildYaesu5ByteFrequencyCommand(downlinkHz), `CAT Rx VFO`);
        if (uplinkHz > 0) {
          if (!warnedNoUplinkTune) {
            warnedNoUplinkTune = true;
            appendSerialLog(`${profile.name} uplink not retuned: this CAT protocol has no VFO-select command. Downlink Doppler is still tracking; retune TX manually.`);
          }
        }
      } else {
        if (downlinkHz > 0) await cat.sendCommand(`FA${downlinkHz};`, `CAT Rx A`);
        if (uplinkHz > 0) await cat.sendCommand(`FB${uplinkHz};`, `CAT Tx B`);
      }

      if (downlinkHz > 0) {
        cat.setStagedFrequencyAndNotify(downlinkHz);
      }
    }

    // ====== Wiring ======
    els.fetchTleBtn?.addEventListener("click", () => { void fetchSatTles(); });
    els.satSelector?.addEventListener("change", handleSatSelectionChange);
    els.satAutoTune?.addEventListener("change", (e) => { satAutoDopplerTune = e.target.checked; });
    els.connectRotatorBtn?.addEventListener("click", () => { void rotator.connect(); });
    els.disconnectRotatorBtn?.addEventListener("click", () => { void rotator.disconnect(); });
    els.rotatorAutoTrack?.addEventListener("change", (e) => { satRotatorAutoTrack = e.target.checked; });
    els.satObserverGrid?.addEventListener("change", (e) => {
      satLastObserverGrid = e.target.value.trim().toUpperCase();
      if (els.satObserverGrid) els.satObserverGrid.value = satLastObserverGrid;
    });

    // Rotator connector event seam — see js/connectors/rotator.js and header
    // note. Replaces the inline els.rotatorStatus/connectRotatorBtn/
    // disconnectRotatorBtn writes that used to live directly in the monolith's
    // connectRotator()/disconnectRotator().
    rotator.addEventListener("status", (e) => {
      rotatorConnected = e.detail === "connected";
      els.rotatorStatus.textContent = rotatorConnected ? "Connected" : "Disconnected";
      els.connectRotatorBtn.disabled = rotatorConnected;
      els.disconnectRotatorBtn.disabled = !rotatorConnected;
    });
    rotator.addEventListener("serial-log", (e) => appendSerialLog(e.detail));

    // A new radio profile may have a VFO-select command the previous one
    // lacked (or vice versa) — let the uplink-not-tuned warning re-latch.
    // See js/apps/radio/index.js's handleProfileChange() (dispatch site)
    // and the warnedNoUplinkTune declaration above.
    bus.addEventListener("radio-profile-changed", () => { warnedNoUplinkTune = false; });
  }
};
