// Spots mini-app — the POTA activator spot list, its filters, and the click-to-
// tune action.
//
// Constraints worth knowing before changing anything here:
//
// - The filter text and the band/mode selections live on the spots CONNECTOR,
//   not here, because the map app renders the same filtered list and cannot
//   import this module. This app calls the setters; both read
//   getFilteredPotaSpots().
//
// - The band/mode selects have a "follow the radio" option. That is resolved to
//   a concrete band/mode here before being handed to the connector, so the
//   connector never has to know the concept exists.
//
// - Clicking a spot stages a tune on the cat connector and dispatches bus
//   "prefill-log" for the logger, rather than reaching into either.
//
// - The 60-second refresh skips while the document is hidden. POTA's API is
//   volunteer-run and this used to poll it from every backgrounded tab.
import { escapeHtml, inferBandFromFrequency } from "../../utils.js";
import { appendSerialLog } from "../../serial-log.js";

function buildSpotSummary(spot) {
  const ageMinutes = spot.spotTime ? Math.max(0, Math.round((Date.now() - spot.spotTime.getTime()) / 60000)) : null;
  const parts = [
    ageMinutes === null ? null : `${ageMinutes}m ago`,
    spot.count ? `${spot.count} QSOs` : null,
    spot.spotter ? `spotter ${spot.spotter}` : null,
    spot.source ? `source ${spot.source}` : null
  ].filter(Boolean);
  const comment = spot.comments ? ` ${spot.comments}` : "";
  return `${parts.join(" | ")}${comment}`.trim();
}

export default {
  id: "spots",
  title: "Clusters",
  mount(panelEl, ctx) {
    const { cat, spots, bus } = ctx;

    const els = {
      potaFilter: panelEl.querySelector("#pota-filter"),
      spotsBandFilter: panelEl.querySelector("#spots-band-filter"),
      spotsModeFilter: panelEl.querySelector("#spots-mode-filter"),
      potaSpotList: panelEl.querySelector("#pota-spot-list"),
      refreshPotaBtn: panelEl.querySelector("#refresh-pota-btn"),
      potaStatus: panelEl.querySelector("#pota-status"),
      // Shared element outside #tab-spots — same dual-query pattern
      // js/apps/satellites/index.js and js/apps/audio-macros/index.js use
      // for #serial-log.
    };


    function renderPotaSpots() {
      const filteredSpots = spots.getFilteredPotaSpots();
      if (!filteredSpots.length) {
        els.potaSpotList.innerHTML = '<div class="empty-state">No POTA spots match the current filter.</div>';
        return;
      }

      els.potaSpotList.innerHTML = filteredSpots
        .slice(0, 12)
        .map(
          (spot) => `
            <article class="spot-card">
              <div class="spot-card-header">
                <div class="spot-title">
                  <strong>${escapeHtml(spot.activator)}</strong>
                  <span class="badge muted">${escapeHtml(spot.mode || "Unknown")}</span>
                </div>
                <span>${escapeHtml(spot.frequencyText)}</span>
              </div>
              <div class="spot-meta">
                <span>${escapeHtml(spot.reference || "No Ref")}</span>
                <span>${escapeHtml(spot.parkName || "Unnamed Park")}</span>
                <span>${escapeHtml(spot.locationDesc || "Unknown Area")}</span>
                <span>${escapeHtml(spot.grid || "No Grid")}</span>
              </div>
              <p>${escapeHtml(buildSpotSummary(spot))}</p>
              <div class="spot-actions">
                <button type="button" class="secondary" data-action="spot-tune" data-spot-id="${escapeHtml(spot.id)}">Tune + Prefill</button>
                <button type="button" class="secondary" data-action="spot-fill" data-spot-id="${escapeHtml(spot.id)}">Prefill Log Only</button>
              </div>
            </article>
          `
        )
        .join("");
    }

    async function handlePotaSpotClick(event) {
      const button = event.target.closest("[data-spot-id]");
      if (!button) {
        return;
      }

      const spot = spots.getPotaSpots().find((item) => item.id === button.dataset.spotId);
      if (!spot) {
        return;
      }

      if (button.dataset.action === "spot-fill") {
        bus.dispatchEvent(new CustomEvent("prefill-log", { detail: spot }));
        appendSerialLog(`Prefilled the log for POTA spot ${spot.activator} ${spot.reference}.`);
        return;
      }

      await tuneAndPrefillSpot(spot);
    }

    async function tuneAndPrefillSpot(spot) {
      bus.dispatchEvent(new CustomEvent("prefill-log", { detail: spot }));
      cat.stageTune(spot.frequencyHz, spot.mode);

      if (cat.isConnected()) {
        await cat.setFrequency(cat.getStagedFrequency());
        await cat.setMode();
        appendSerialLog(`Tuned to POTA spot ${spot.activator} on ${spot.frequencyText} and prefilled the log.`);
      } else {
        appendSerialLog(`Radio not connected, but staged ${spot.frequencyText} / ${spot.mode} and prefilled the log for ${spot.activator}.`);
      }
    }

    async function fetchPotaSpots(force = false) {
      if (els.refreshPotaBtn) {
        els.refreshPotaBtn.disabled = true;
      }
      if (els.potaStatus) {
        els.potaStatus.textContent = force ? "Refreshing Spots" : "Loading Spots";
      }

      try {
        await spots.fetchPotaSpots(force);
      } finally {
        if (els.refreshPotaBtn) {
          els.refreshPotaBtn.disabled = false;
        }
      }
    }

    // The Band/Mode selects' "Radio" option means "whatever the connected
    // rig is currently on" — resolved here (against the cat connector) into
    // a concrete band/mode string before it's pushed to the spots connector,
    // which only ever deals in concrete filter values. Falls back to no
    // filter on that dimension when the rig isn't connected/has no reading
    // yet, rather than silently showing an empty list with no explanation.
    function applyBandModeFilters() {
      const bandSel = els.spotsBandFilter?.value || "";
      const modeSel = els.spotsModeFilter?.value || "";
      const band = bandSel === "radio" ? inferBandFromFrequency(cat.getFrequency()) : bandSel;
      const mode = modeSel === "radio" ? cat.getMode() : modeSel;
      spots.setBandFilter(band);
      spots.setModeFilter(mode);
      renderPotaSpots();
      bus.dispatchEvent(new CustomEvent("spots-filter-changed"));
    }

    // ====== Wiring ======
    els.potaFilter?.addEventListener("input", () => {
      spots.setPotaFilter(els.potaFilter.value.trim().toLowerCase());
      renderPotaSpots();
      // js/apps/map/index.js's own bus.addEventListener("spots-filter-changed", ...)
      // runs the real renderMap() re-render on this event.
      bus.dispatchEvent(new CustomEvent("spots-filter-changed"));
    });
    els.spotsBandFilter?.addEventListener("change", applyBandModeFilters);
    els.spotsModeFilter?.addEventListener("change", applyBandModeFilters);
    // Keep a "Radio" filter live as the rig retunes — re-resolve on every
    // frequency/mode update, but only while that select is actually on
    // "radio" (cheap no-op otherwise).
    cat.addEventListener("frequency", () => {
      if (els.spotsBandFilter?.value === "radio") applyBandModeFilters();
    });
    cat.addEventListener("mode", () => {
      if (els.spotsModeFilter?.value === "radio") applyBandModeFilters();
    });
    els.potaSpotList?.addEventListener("click", handlePotaSpotClick);
    els.refreshPotaBtn?.addEventListener("click", () => { void fetchPotaSpots(true); });
    // Map app's marker popup dispatches this; single owner of tuneAndPrefillSpot logic.
    bus.addEventListener("tune-and-prefill-spot", (e) => tuneAndPrefillSpot(e.detail));

    // Own "pota" listener for this app's rendering — js/apps/map/index.js
    // (map pins) registers its own separate "pota" listener for its own
    // rendering.
    spots.addEventListener("pota", () => renderPotaSpots());

    renderPotaSpots();
    void fetchPotaSpots();

    // POTA's spot API is a volunteer-run service, and this polled it every 60
    // seconds for the entire life of the page — in every open tab, whether or not
    // anyone was looking. Skip the poll while the document is hidden and catch up
    // once on the way back, so a backgrounded WebHam costs POTA nothing.
    const POTA_POLL_MS = 60000;
    let lastPotaFetch = Date.now();
    const refreshPota = () => {
      lastPotaFetch = Date.now();
      void fetchPotaSpots(true);
    };
    window.setInterval(() => {
      if (document.hidden) return;
      refreshPota();
    }, POTA_POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - lastPotaFetch >= POTA_POLL_MS) refreshPota();
    });
  }
};
