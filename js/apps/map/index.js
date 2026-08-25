// Map mini-app — the QSO/POTA-spot map, the PSKReporter "who heard me" layer,
// and the FT8 GridTracker-style live-decode view.
//
// Constraints worth knowing before changing anything here:
//
// - Leaflet is loaded on demand by js/vendor.js, which tries the local vendor
//   copy and falls back to unpkg. vendor/leaflet/ is not in the repo today, so
//   the CDN is the only path that resolves and the map does not work offline.
//   leafletReady() resolves false rather than rejecting; the map shows a message.
//
// - FT8 state (session running, worked callsigns, decode history) is read
//   through ctx.ft8, which is undefined until that app mounts and whose values
//   are reassigned as sessions start and stop — so every read is optional-chained
//   and happens at render time, never captured at mount.
//
// - Bus events it listens for: "ft8-decodes", "map-refresh",
//   "ft8-session-stopping", "tab-activated", "spots-filter-changed".
//   "tab-activated" matters: Leaflet renders grey at the wrong size unless
//   invalidateSize() runs once the panel is actually visible.
//
// - PSK reception reports come from the spots connector, which owns their
//   expiry. This module only draws whatever getPskSpots() returns.
import {
  maidenheadToLatLon, gridDistanceKm, gridBearingDeg, gridSquareBounds,
  bandColor, ft8FindGridField,
} from "../../grid.js";
import { inferBandFromFrequency, escapeHtml } from "../../utils.js";
import { leafletReady } from "../../vendor.js";
import { appendSerialLog } from "../../serial-log.js";

export default {
  id: "map",
  title: "Map",
  mount(panelEl, ctx) {
    const { cat, spots, logbook, bus } = ctx;

    const els = {
      qsoMap: panelEl.querySelector("#qso-map"),
      mapModeControl: panelEl.querySelector("#map-mode"),
      mapDecodeStyleControl: panelEl.querySelector("#map-decode-style"),
      resetMapBtn: panelEl.querySelector("#reset-map-btn"),
      // Outside #tab-map — same dual-query pattern js/apps/settings/index.js
      // (#ft8-my-call/etc) and js/apps/spots/index.js (#serial-log) use.
      ft8MyCall: document.querySelector("#ft8-my-call"),
    };

    let mapInstance = null;
    let mapSpotLayer = null;
    let mapQsoLayer = null;
    let mapFt8Layer = null;
    let mapLineLayer = null;
    let mapPskLayer = null;
    let mapHasAutoFit = false;
    let mapMode = localStorage.getItem("webham.mapMode") || "auto";
    let mapDecodeStyle = localStorage.getItem("webham.mapDecodeStyle") || "pins";


    function isFt8SessionRunning() {
      return !!ctx.ft8?.sessionRunning;
    }

    function effectiveMapMode() {
      if (mapMode === "auto") return isFt8SessionRunning() ? "ft8" : "pota";
      return mapMode;
    }

    function operatorGrid() {
      // Source of truth is the settings connector, not the FT8 tab's DOM input
      // (settings persists #ft8-my-grid live — see js/apps/settings/index.js).
      return (ctx.settings.get().ft8MyGrid || "").trim().toUpperCase();
    }

    // Status color — independent of the PSKReporter band palette.
    function ft8DecodeStatusColor(msg) {
      const call = (msg.text || "").split(/\s+/)[1] || "";
      if (ctx.ft8?.workedCallsigns?.has(call.toUpperCase())) return "#9aa5b1"; // worked: grey
      if (msg.newGrid) return "#ffcf33";                                        // new grid: gold
      if (/\bCQ\b/i.test(msg.text)) return "#3ddc84";                           // CQ: green
      return "#38c0ff";                                                         // default: blue
    }

    // Grid-cell coloring for the GridTracker-style grid view (color-picked palette).
    // Simpler subset: CQ DX=cyan, CQ=green, worked=yellow, else=blue (QSX/station-to-station).
    // The home gridsquare (orange) is drawn separately in renderFt8Map.
    function ft8GridStatusColor(msg) {
      const text = msg.text || "";
      if (/\bCQ\s+DX\b/i.test(text)) return "#00FAFA";                          // CQ DX: cyan
      if (/\bCQ\b/i.test(text)) return "#00FA00";                               // CQ: green
      const call = (text.split(/\s+/)[1] || "").toUpperCase();
      if (ctx.ft8?.workedCallsigns?.has(call)) return "#E6E600";  // worked: yellow
      return "#0A0AE6";                                                         // other directed: blue
    }

    function openSpotPopup(spot, myGrid) {
      const esc = (s) => escapeHtml(s ?? "");
      const pt = maidenheadToLatLon(spot.grid);
      if (!pt || !mapInstance) return;
      const band = spot.band || inferBandFromFrequency(spot.freqHz || 0);
      const dist = myGrid ? gridDistanceKm(myGrid, spot.grid) : null;
      const azim = myGrid ? gridBearingDeg(myGrid, spot.grid) : null;
      const age = spot.epoch ? `${Math.max(0, Math.round((Date.now() / 1000 - spot.epoch) / 60))}m` : "—";
      const freq = spot.freqHz ? `${(spot.freqHz / 1e6).toFixed(6)} MHz` : "—";
      const rows = [
        ["Call", spot.call || "—"],
        ["dB", spot.snr ?? "—"],
        ["Age", age],
        ["Grid", spot.grid],
        ["Freq", band ? `${freq} (${band})` : freq],
        ["Mode", spot.mode || "FT8"],
        ["Dist", dist != null ? `${dist} km` : "—"],
        ["Azim", azim != null ? `${azim}°` : "—"],
        ["Source", spot.source || "—"],
      ];
      const html = `<table class="spot-popup"><caption style="color:${bandColor(band)}">${esc(spot.call || "Spot")}</caption>` +
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("") + "</table>";
      mapInstance.openPopup(window.L.popup().setLatLng([pt.latitude, pt.longitude]).setContent(html));
    }

    async function connectPskReporter() {
      const call = (els.ft8MyCall?.value || "").trim().toUpperCase();
      await spots.connectPsk(call, () => effectiveMapMode() === "ft8");
    }

    function disconnectPskReporter() {
      spots.disconnectPsk();
      mapPskLayer?.clearLayers();
    }

    function renderPskLayer() {
      if (!mapPskLayer || !window.L) return;
      mapPskLayer.clearLayers();
      const myGrid = operatorGrid();
      const myPoint = maidenheadToLatLon(myGrid);
      // Expiry moved into the spots connector (PSK_TTL_MS) — it owns the data,
      // and doing it here meant reports only expired while the map was drawing.
      for (const [, { spot }] of spots.getPskSpots()) {
        const pt = maidenheadToLatLon(spot.grid);
        if (!pt) continue;
        const color = bandColor(spot.band || inferBandFromFrequency(spot.freqHz || 0));
        // Teardrop-ish: a filled marker distinct from the round decode pins (square).
        const marker = window.L.circleMarker([pt.latitude, pt.longitude], {
          radius: 6, color: "#000", weight: 1, fillColor: color, fillOpacity: 0.95,
        });
        marker.bindTooltip(`${escapeHtml(spot.call)} heard you · ${escapeHtml(spot.band || "")}`);
        marker.on("click", () => openSpotPopup({ ...spot, source: "PSK-MQTT" }, myGrid));
        marker.addTo(mapPskLayer);
        if (myPoint) {
          window.L.polyline([[myPoint.latitude, myPoint.longitude], [pt.latitude, pt.longitude]], {
            color, weight: 1, opacity: 0.6, dashArray: "4 4",
          }).addTo(mapPskLayer);
        }
      }
    }

    function renderFt8Map() {
      if (!mapInstance || !window.L) return;
      mapSpotLayer?.clearLayers();
      mapQsoLayer?.clearLayers();
      mapFt8Layer.clearLayers();
      mapLineLayer.clearLayers();

      const myGrid = operatorGrid();
      const myPoint = maidenheadToLatLon(myGrid);
      const useGrids = mapDecodeStyle === "grids";
      const slots = (ctx.ft8?.decodeHistory || []).slice();   // oldest..newest
      const total = slots.length || 1;
      const seen = new Set();                          // dedup by call, newest wins
      const bounds = [];

      // Home gridsquare cell (orange), drawn once when showing grid cells.
      if (useGrids) {
        const home = gridSquareBounds(myGrid);
        if (home) {
          window.L.rectangle([home.sw, home.ne], {
            color: "#FAA000", weight: 1, fillColor: "#FAA000", fillOpacity: 0.45,
          }).bindTooltip(`Home ${escapeHtml(myGrid)}`).addTo(mapFt8Layer);
        }
      }

      for (let i = slots.length - 1; i >= 0; i -= 1) {
        const age = slots.length - 1 - i;              // 0 = newest
        const fade = Math.max(0.25, 1 - age / total);  // older -> dimmer/smaller
        for (const msg of slots[i].messages) {
          const call = (msg.text || "").split(/\s+/)[1] || "";
          if (!call || seen.has(call.toUpperCase())) continue;
          const field = ft8FindGridField(msg.text);
          const pt = field ? maidenheadToLatLon(field) : null;
          if (!pt) continue;
          seen.add(call.toUpperCase());
          const spot = {
            call, grid: field, snr: msg.db, freqHz: null,
            band: "", mode: "FT8", source: "Local decode",
          };
          if (useGrids) {
            const cell = gridSquareBounds(field);
            if (cell) {
              const rect = window.L.rectangle([cell.sw, cell.ne], {
                color: "#04121c", weight: 1,
                fillColor: ft8GridStatusColor(msg), fillOpacity: Math.max(0.35, 0.7 * fade),
              });
              rect.bindTooltip(`${escapeHtml(call)} ${escapeHtml(field)} ${escapeHtml(msg.db ?? "")}dB`);
              rect.on("click", () => openSpotPopup(spot, myGrid));
              rect.addTo(mapFt8Layer);
            }
          } else {
            const marker = window.L.circleMarker([pt.latitude, pt.longitude], {
              radius: 4 + 3 * fade,
              color: "#04121c",
              weight: 1,
              fillColor: ft8DecodeStatusColor(msg),
              fillOpacity: fade,
            });
            marker.bindTooltip(`${escapeHtml(call)} ${escapeHtml(field)} ${escapeHtml(msg.db ?? "")}dB`);
            marker.on("click", () => openSpotPopup(spot, myGrid));
            marker.addTo(mapFt8Layer);
          }
          bounds.push([pt.latitude, pt.longitude]);
          if (myPoint) {
            window.L.polyline([[myPoint.latitude, myPoint.longitude], [pt.latitude, pt.longitude]], {
              color: "#38c0ff", weight: 1, opacity: 0.35 * fade,
            }).addTo(mapLineLayer);
          }
        }
      }

      renderLoggedQsoMarkers(bounds);

      if (!mapHasAutoFit && bounds.length) {
        mapInstance.fitBounds(bounds, { padding: [28, 28], maxZoom: 6 });
        mapHasAutoFit = true;
      }

      renderPskLayer();
      if (effectiveMapMode() === "ft8") void connectPskReporter();
    }

    // Single entry point the rest of the app calls instead of renderQsoMap directly.
    function renderMap() {
      if (!mapInstance || !window.L) return;
      const ft8 = effectiveMapMode() === "ft8";
      // Pins/Grids toggle only applies to live decodes, so hide it outside FT8 mode.
      if (els.mapDecodeStyleControl) els.mapDecodeStyleControl.hidden = !ft8;
      if (ft8) {
        renderFt8Map();
      } else {
        renderQsoMap();
      }
    }


    function renderQsoMap() {
      if (!mapInstance || !window.L) {
        return;
      }

      mapSpotLayer.clearLayers();
      mapQsoLayer.clearLayers();
      mapFt8Layer?.clearLayers();
      mapLineLayer?.clearLayers();

      const bounds = [];

      spots.getFilteredPotaSpots()
        .filter((spot) => Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude))
        .slice(0, 100)
        .forEach((spot) => {
          const marker = window.L.circleMarker([spot.latitude, spot.longitude], {
            radius: 7,
            color: "#ffffff",
            weight: 1,
            fillColor: "#38c0ff",
            fillOpacity: 0.92
          });
          marker.bindTooltip(`${escapeHtml(spot.activator)} ${escapeHtml(spot.reference)} ${escapeHtml(spot.frequencyText)} ${escapeHtml(spot.mode)}`);
          // Handled once by the spots app via its "tune-and-prefill-spot" listener.
          marker.on("click", () => {
            bus.dispatchEvent(new CustomEvent("tune-and-prefill-spot", { detail: spot }));
          });
          marker.addTo(mapSpotLayer);
          bounds.push([spot.latitude, spot.longitude]);
        });

      renderLoggedQsoMarkers(bounds);

      if (!mapHasAutoFit) {
        if (bounds.length) {
          mapInstance.fitBounds(bounds, { padding: [28, 28], maxZoom: 5 });
        } else {
          mapInstance.setView([20, 0], 2);
        }
        mapHasAutoFit = true;
      }
    }

    // Plot logged QSOs (orange dots) onto mapQsoLayer. Shared by the POTA/QSO view
    // and the FT8 view so worked stations show as GridTracker-style context under
    // the live decodes. Pushes each plotted point into `bounds` for auto-fit.
    function renderLoggedQsoMarkers(bounds) {
      logbook.qsos()
        .map((qso) => ({ qso, point: qsoToPoint(qso) }))
        .filter(({ point }) => point)
        .slice(0, 100)
        .forEach(({ qso, point }) => {
          const marker = window.L.circleMarker([point.latitude, point.longitude], {
            radius: 5,
            color: "#fff2ca",
            weight: 1,
            fillColor: "#ffb347",
            fillOpacity: 0.88
          });
          marker.bindTooltip(`${escapeHtml(qso.callsign || "Logged QSO")} ${escapeHtml(qso.gridSquare || "")} ${escapeHtml(qso.frequency || "")}`);
          marker.addTo(mapQsoLayer);
          bounds.push([point.latitude, point.longitude]);
        });
    }

    function resetMapView() {
      if (!mapInstance) {
        return;
      }

      const bounds = [];
      mapSpotLayer?.eachLayer((layer) => bounds.push(layer.getLatLng()));
      mapQsoLayer?.eachLayer((layer) => bounds.push(layer.getLatLng()));

      if (bounds.length) {
        mapInstance.fitBounds(bounds, { padding: [28, 28], maxZoom: 5 });
      } else {
        mapInstance.setView([20, 0], 2);
      }
    }

    function qsoToPoint(qso) {
      const grid = String(qso.gridSquare || "").trim().toUpperCase();
      if (!/^[A-R]{2}\d{2}([A-X]{2})?$/.test(grid)) {
        return null;
      }

      return maidenheadToLatLon(grid);
    }

    async function initializeProviderMap() {
      if (mapInstance) {
        return;
      }

      // leafletReady() resolves false rather than rejecting, and is memoised, so
      // this is safe to call on every map init rather than once at mount.
      await leafletReady();

      if (!window.L) {
        els.qsoMap.innerHTML = '<div class="empty-state">Leaflet map failed to load. Check your connection and try again.</div>';
        return;
      }

      mapInstance = window.L.map(els.qsoMap, {
        worldCopyJump: true,
        minZoom: 2,
        zoomControl: true
      }).setView([20, 0], 2);

      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(mapInstance);

      mapSpotLayer = window.L.layerGroup().addTo(mapInstance);
      mapQsoLayer = window.L.layerGroup().addTo(mapInstance);
      mapLineLayer = window.L.layerGroup().addTo(mapInstance);
      mapFt8Layer = window.L.layerGroup().addTo(mapInstance);
      mapPskLayer = window.L.layerGroup().addTo(mapInstance);
    }

    // ====== Wiring ======
    els.resetMapBtn?.addEventListener("click", resetMapView);
    els.mapModeControl?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-map-mode]");
      if (!btn) return;
      mapMode = btn.dataset.mapMode;
      localStorage.setItem("webham.mapMode", mapMode);
      els.mapModeControl.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.mapMode === mapMode;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderMap();
      if (effectiveMapMode() === "ft8") { void connectPskReporter(); renderPskLayer(); }
      else disconnectPskReporter();
    });
    els.mapDecodeStyleControl?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-decode-style]");
      if (!btn) return;
      mapDecodeStyle = btn.dataset.decodeStyle;
      localStorage.setItem("webham.mapDecodeStyle", mapDecodeStyle);
      els.mapDecodeStyleControl.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.decodeStyle === mapDecodeStyle;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderMap();
    });

    // Own "pota" listener for this app's rendering — js/apps/radio/index.js
    // (status text/summary labels/band chart) and js/apps/spots/index.js
    // (serial-log) each register their own separate "pota" listeners for
    // their own rendering.
    spots.addEventListener("pota", () => renderMap());
    spots.addEventListener("psk", () => {
      if (effectiveMapMode() === "ft8") renderPskLayer();
    });

    // dispatched by the spots app on every #pota-filter keystroke;
    // registered here (instead of the old monolith) as of this task.
    bus.addEventListener("spots-filter-changed", () => renderMap());
    // See this file's header note for what each of these three carries and why.
    bus.addEventListener("ft8-decodes", () => {
      if (effectiveMapMode() === "ft8") renderMap();
    });
    bus.addEventListener("ft8-session-stopping", () => {
      if (mapMode === "auto") disconnectPskReporter();
    });
    bus.addEventListener("map-refresh", () => renderMap());
    bus.addEventListener("tab-activated", (e) => {
      if (e.detail === "map" && mapInstance) {
        // Port of main@f81b816: invalidate Leaflet size when map tab is revealed
        window.setTimeout(() => mapInstance.invalidateSize(), 60);
        renderMap();
      }
    });

    async function bootMap() {
      await initializeProviderMap();
      renderMap();
      els.mapModeControl?.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.mapMode === mapMode;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      els.mapDecodeStyleControl?.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.decodeStyle === mapDecodeStyle;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    void bootMap();
  }
};
