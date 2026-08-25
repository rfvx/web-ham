// Logbook mini-app — the QSO entry form and table (with two-level inline/form
// editing), the logbook selector, Cabrillo and ADIF export, and LoTW
// sign-upload/sync.
//
// Constraints worth knowing before changing anything here:
//
// - Three elements it owns live outside #tab-logger: #wh-add-entry and
//   #qso-count in the shell top strip, and #row-template, a bare <template>
//   near the end of <body>. Queried from `document`, like every other
//   reach outside a panel.
//
// - Bus events it LISTENS for: "prefill-log" (a spot click on the Spots or Map
//   tab stages a QSO here), "radio-profile-changed", "dupe-banner-refresh".
//   Bus events it DISPATCHES: "activate-tab" (the shell reveals this tab —
//   "+ New QSO" has to work when the tab is closed or the other pane is
//   maximised), "freq-band-chip-refresh", "mode-quickset-refresh",
//   "radio-console-sync".
//
// - It publishes ctx.logger (seedDateTime, buildQsoFromForm) at the END of
//   mount(), for the FT8 app to build a QSO from a completed exchange. FT8 reads
//   it optional-chained at call time, never captured, because either app may
//   mount first.
//
// - The entry pad's Tab order is managed, not the DOM's. nextTabTarget() in
//   js/utils.js is the pure rule (main flow, top flow, and how they join) so the
//   ordering can be tested without a DOM; TAB_FLOW_MAIN/TAB_FLOW_TOP below map
//   it onto each pad type. Hidden fields drop out automatically — the resolver
//   filters on offsetParent.
//
// - Contest exchange fields are composed from js/connectors/contests-generated.js
//   rather than hardcoded per contest.
import { escapeHtml, parseFrequencyText, inferBandFromFrequency, nextTabTarget } from "../../utils.js";
import {
  CONTESTS, EXCHANGE_FIELDS, LOGBOOK_TYPE_LABELS, US_STATES, PARK_REF_RE, SUMMIT_REF_RE,
  CABRILLO_CATEGORIES, contestFor, composeExchange, nextSerial,
} from "../../connectors/logbook.js";
import { getLotwP12Meta, getSecret } from "../../connectors/secure-store.js";
import { appendSerialLog } from "../../serial-log.js";

const LOTW_SYNC_KEY = "web-ham-logger.lotw-last-sync";
// APP_LoTW_LASTQSL from the previous report. Its presence is also what marks a
// station as bootstrapped: without it the next sync pulls the whole log.
const LOTW_CURSOR_KEY = "web-ham-logger.lotw-last-qsl";
// Confirmations arrive at the speed of the other operator uploading theirs;
// nothing is gained by asking ARRL more often than this. See
// docs/lotw-rate-limits.md.
const LOTW_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

const LOGBOOK_TYPE_HINTS = {
  general: "The full log form with every field.",
  pota: "Parks on the Air — quick field form with your park reference.",
  sota: "Summits on the Air — quick field form with your summit reference.",
  contest: "Pick the contest; exchanges and Cabrillo export are set up for you."
};

export default {
  id: "logger",
  title: "Logbook",
  mount(panelEl, ctx) {
    const { cat, logbook, lookup, settings, bus } = ctx;

    let editingQsoId = null;
    let editMode = null; // "inline" | "form" | null
    let callsignLookupTimerId = null;
    let callsignLookupController = null;
    let rowClickTimer = null;
    let lotwStatusTimer = null;

    const els = {
      loggerBandFilter: panelEl.querySelector("#logger-band-filter"),
      loggerModeFilter: panelEl.querySelector("#logger-mode-filter"),
      loggerLotwFilter: panelEl.querySelector("#logger-lotw-filter"),
      loggerFilterToggle: panelEl.querySelector("#logger-filter-toggle"),
      // Cross-tab: shell header (outside #tab-logger) — see this file's
      // header note.
      whAddEntry: document.querySelector("#wh-add-entry"),
      whNewQso: panelEl.querySelector("#wh-new-qso"),
      whLogbookSubtitle: panelEl.querySelector("#wh-logbook-subtitle"),
      whMobileOpMeta: panelEl.querySelector("#wh-mobile-op-meta"),
      whLogbookTableFooter: panelEl.querySelector("#wh-logbook-table-footer"),
      // Cross-tab: shell top strip (QSOs stat), outside #tab-logger —
      // verified against index.html, same dual-query pattern as whAddEntry.
      qsoCount: document.querySelector("#qso-count"),
      qsoForm: panelEl.querySelector("#qso-form"),
      logbookSelector: panelEl.querySelector("#logbook-selector"),
      logbookView: panelEl.querySelector("#logbook-view"),
      logbookList: panelEl.querySelector("#logbook-list"),
      logbookNewBtn: panelEl.querySelector("#logbook-new-btn"),
      logbookCreate: panelEl.querySelector("#logbook-create"),
      logbookCreateForm: panelEl.querySelector("#logbook-create-form"),
      logbookName: panelEl.querySelector("#logbook-name"),
      logbookType: panelEl.querySelector("#logbook-type"),
      logbookTypeSeg: panelEl.querySelector("#logbook-type-seg"),
      logbookTypeHint: panelEl.querySelector("#logbook-type-hint"),
      whOpFacts: panelEl.querySelector("#wh-op-facts"),
      whOpCount: panelEl.querySelector("#wh-op-count"),
      whOpCountCaption: panelEl.querySelector("#wh-op-count-caption"),
      whOpPace: panelEl.querySelector("#wh-op-pace"),
      whExportNote: panelEl.querySelector("#wh-export-note"),
      whLotwNote: panelEl.querySelector("#wh-lotw-note"),
      whLogbookFooterRow: panelEl.querySelector("#wh-logbook-footer-row"),
      logbookRefRow: panelEl.querySelector("#logbook-ref-row"),
      logbookRefLabel: panelEl.querySelector("#logbook-ref-label"),
      logbookRef: panelEl.querySelector("#logbook-ref"),
      logbookNearbyBtn: panelEl.querySelector("#logbook-nearby-btn"),
      logbookNearbyResults: panelEl.querySelector("#logbook-nearby-results"),
      logbookContestRow: panelEl.querySelector("#logbook-contest-row"),
      logbookContest: panelEl.querySelector("#logbook-contest"),
      logbookEntryCat: panelEl.querySelector("#logbook-entry-cat"),
      logbookExchMe: panelEl.querySelector("#logbook-exch-me"),
      logbookCreateCancel: panelEl.querySelector("#logbook-create-cancel"),
      logbookBackBtn: panelEl.querySelector("#logbook-back-btn"),
      logbookTitle: panelEl.querySelector("#wh-logbook-title"),
      theirRefLabel: panelEl.querySelector("#their-ref-label"),
      theirRefInput: panelEl.querySelector("#their-ref"),
      theirRefReadout: panelEl.querySelector("#their-ref-readout"),
      theirLocationInput: panelEl.querySelector("#their-location"),
      contestExchRcvd: panelEl.querySelector("#contest-exch-rcvd"),
      contestExchSent: panelEl.querySelector("#contest-exch-sent"),
      exportCabrilloBtn: panelEl.querySelector("#export-cabrillo-btn"),
      callsignInput: panelEl.querySelector("#callsign"),
      qsoDate: panelEl.querySelector("#qso-date"),
      qsoTime: panelEl.querySelector("#qso-time"),
      frequencyInput: panelEl.querySelector("#frequency"),
      bandInput: panelEl.querySelector("#band"),
      mfreqSummary: panelEl.querySelector("#wh-mfreq-summary"),
      mfreqValue: panelEl.querySelector("#wh-mfreq-value"),
      mfreqBand: panelEl.querySelector("#wh-mfreq-band"),
      mfreqMode: panelEl.querySelector("#wh-mfreq-mode"),
      gridSquareInput: panelEl.querySelector("#grid-square"),
      dupeBanner: panelEl.querySelector("#dupe-banner"),
      dupeBannerText: panelEl.querySelector("#dupe-banner-text"),
      qsoFormCard: panelEl.querySelector("#qso-form-card"),
      callsignFound: panelEl.querySelector("#callsign-found"),
      potaMoreToggle: panelEl.querySelector("#pota-more-toggle"),
      qsoFormHeading: panelEl.querySelector("#qso-form-heading"),
      qsoFormBadge: panelEl.querySelector("#qso-form-badge"),
      qsoFormSubmit: panelEl.querySelector("#qso-form-submit"),
      deleteQsoBtn: panelEl.querySelector("#delete-qso-btn"),
      resetFormBtn: panelEl.querySelector("#reset-form-btn"),
      searchInput: panelEl.querySelector("#search-input"),
      exportAdifBtn: panelEl.querySelector("#export-adif-btn"),
      lotwDownloadBtn: panelEl.querySelector("#lotw-download-btn"),
      lotwSignUploadBtn: panelEl.querySelector("#lotw-sign-upload-btn"),
      lotwStatus: panelEl.querySelector("#lotw-status"),
      callsignLookupStatus: panelEl.querySelector("#callsign-lookup-status"),
      callsignLookupSource: panelEl.querySelector("#callsign-lookup-source"),
      callsignLookupCall: panelEl.querySelector("#callsign-lookup-call"),
      callsignLookupOperator: panelEl.querySelector("#callsign-lookup-operator"),
      callsignLookupQth: panelEl.querySelector("#callsign-lookup-qth"),
      callsignLookupGrid: panelEl.querySelector("#callsign-lookup-grid"),
      callsignLookupCountry: panelEl.querySelector("#callsign-lookup-country"),
      emptyState: panelEl.querySelector("#empty-state"),
      qsoTableBody: panelEl.querySelector("#qso-table-body"),
      // Cross-tab: outside every tab panel — see this file's header note.
      rowTemplate: document.querySelector("#row-template"),
    };


    function updateFreqBandChip() {
      bus.dispatchEvent(new CustomEvent("freq-band-chip-refresh"));
    }

    // thin dispatcher mirroring updateFreqBandChip
    // above — the real body lives in js/apps/radio/index.js.
    function updateModeQuickButtons() {
      bus.dispatchEvent(new CustomEvent("mode-quickset-refresh"));
    }

    // Mobile POTA/SOTA pad (7c): the compact freq/band/mode "tap to change"
    // summary. Populated from the live #frequency (falling back to CAT),
    // #band, and #mode; a no-op — and never throws — when the summary markup
    // is absent (desktop/general/contest never render it). Band is recomputed
    // from frequency rather than read from #band alone so it stays correct
    // regardless of bus-listener ordering.
    function updateMobileFreqSummary() {
      if (!els.mfreqValue) return;
      let freq = (els.frequencyInput?.value || "").trim();
      if (!freq) {
        const catHz = parseFrequencyText(cat.getFrequency?.() || "");
        if (catHz) freq = (catHz / 1e6).toFixed(3);
      }
      const hz = freq ? parseFrequencyText(freq) : 0;
      const band = (els.bandInput?.value || (hz ? inferBandFromFrequency(hz) : "")).trim();
      const mode = (document.querySelector("#mode")?.value || "").trim();
      els.mfreqValue.textContent = freq || "—";
      if (els.mfreqBand) els.mfreqBand.textContent = band || "—";
      if (els.mfreqMode) els.mfreqMode.textContent = mode || "—";
    }

    // Toggle the pad's "edit frequency/mode" state (CSS reveals/hides the real
    // inputs vs. the summary). Guarded so a missing card never throws.
    function setMfreqEditing(on) {
      els.qsoFormCard?.classList.toggle("wh-mfreq-editing", on);
      if (on) {
        updateMobileFreqSummary();
        els.frequencyInput?.focus();
      }
    }

    function syncRadioConsole() {
      bus.dispatchEvent(new CustomEvent("radio-console-sync"));
    }

    // ── Callsign lookup ────────────────────────────────────────────────────

    function seedDateTime() {
      const now = new Date();
      els.qsoDate.value = now.toISOString().slice(0, 10);
      els.qsoTime.value = now.toISOString().slice(11, 16);
    }

    // Digital modes exchange an SNR report in dB (−25..+25, e.g. "-12"), not the
    // RST "59"/"599" used on phone/CW. Keep the report fields mode-aware: hint dB
    // for digital, RST otherwise, so manual logging matches what the mode uses.
    const DIGITAL_MODE_RE = /^(FT8|FT4|JT65|JT9|JT4|FST4W?|Q65|MSK144|JS8|WSPR|FSK441|ISCAT|T10)/i;
    function isDigitalMode(mode) { return DIGITAL_MODE_RE.test((mode || "").trim()); }
    function applyModeReportHints() {
      const digital = isDigitalMode(document.querySelector("#mode")?.value);
      const hint = digital ? "-10" : "59";
      const s = document.querySelector("#rst-sent");
      const r = document.querySelector("#rst-received");
      if (s) s.placeholder = hint;
      if (r) r.placeholder = hint;
    }

    function seedQsoDefaults() {
      /* Every form-reset path calls this, so it is the one place that reliably
         kills a lookup racing the reset. */
      cancelPendingLookup();
      seedDateTime();
      document.querySelector("#rig").value = cat.getProfile().name;
      document.querySelector("#mode").value = "FT8";
      updateModeQuickButtons();
      seedContestExchange();
      applyModeReportHints();
      resetLookupUi("Type a callsign to lookup");
      syncRadioConsole();
    }

    /* Cancel a debounced-but-not-yet-fired lookup AND abort one already in
       flight. Without this, a lookup started for the previous callsign lands
       after the form has been reset and writes that station's grid into the
       next QSO — which then plots on the map at the wrong location. */
    function cancelPendingLookup() {
      if (callsignLookupTimerId) {
        window.clearTimeout(callsignLookupTimerId);
        callsignLookupTimerId = null;
      }
      if (callsignLookupController) {
        callsignLookupController.abort();
        callsignLookupController = null;
      }
    }

    /* form.reset() CANNOT clear the hidden grid field. For <input type="hidden">
       the value IDL attribute is in "default" mode, so assigning .value also moves
       defaultValue — and reset() restores it to exactly that stale value. Verified
       in-browser. So every reset path has to clear this field explicitly, or a grid
       looked up for one station silently rides along into the next QSO and plots it
       at the wrong place. */
    function clearHiddenGrid() {
      if (!els.gridSquareInput) return;
      els.gridSquareInput.value = "";
      els.gridSquareInput.defaultValue = "";
      els.gridSquareInput.removeAttribute("value");
    }

    function handleCallsignInputChange() {
      const callsign = els.callsignInput.value.trim().toUpperCase();
      els.callsignInput.value = callsign;
      /* The hidden grid belongs to whichever station is in the field. Editing the
         callsign invalidates it, so drop it and let the next lookup refill it —
         otherwise a grid fetched for a prefix typed on the way to the real call
         (e.g. "K2A" before "K2ABC") sticks and mis-plots the QSO. */
      clearHiddenGrid();
      if (callsignLookupTimerId) {
        window.clearTimeout(callsignLookupTimerId);
      }
      if (!callsign || callsign.length < 3) {
        if (callsignLookupController) {
          callsignLookupController.abort();
          callsignLookupController = null;
        }
        resetLookupUi(callsign ? "Keep typing to lookup callsign details" : "Type a callsign to lookup");
        return;
      }
      els.callsignLookupStatus.textContent = "Looking up callsign...";
      callsignLookupTimerId = window.setTimeout(() => {
        void lookupCallsign(callsign);
      }, 350);
    }

    function resetLookupUi(statusText) {
      els.callsignLookupStatus.textContent = statusText;
      els.callsignLookupSource.textContent = "--";
      els.callsignLookupCall.textContent = "--";
      els.callsignLookupOperator.textContent = "--";
      els.callsignLookupQth.textContent = "--";
      els.callsignLookupGrid.textContent = "--";
      els.callsignLookupCountry.textContent = "--";
      if (els.callsignFound) { els.callsignFound.textContent = ""; els.callsignFound.hidden = true; }
    }

    // Not in this task's named move list, but moved anyway: its only caller
    // (handleCallsignInputChange, above) moves, and every element it touches
    // is logger-form-only — same "moved anyway" precedent
    // js/apps/radio/index.js's header note uses for persistCatSettings.
    async function lookupCallsign(callsign) {
      if (callsignLookupController) {
        callsignLookupController.abort();
      }
      const controller = new AbortController();
      callsignLookupController = controller;

      try {
        const payload = await lookup.lookupCallsign(callsign, { signal: controller.signal });
        const result = payload.result || {};
        els.callsignLookupStatus.textContent = payload.message || "Lookup complete";
        els.callsignLookupSource.textContent = result.source || "--";
        els.callsignLookupCall.textContent = result.callsign || callsign;
        els.callsignLookupOperator.textContent = result.operatorName || "--";
        els.callsignLookupQth.textContent = result.qth || "--";
        els.callsignLookupGrid.textContent = result.grid || "--";
        els.callsignLookupCountry.textContent = result.country || "--";
        // Compact "found info" line for the POTA/SOTA pad (under Callsign)
        if (els.callsignFound) {
          const bits = [result.operatorName, result.qth, result.country].filter(Boolean);
          els.callsignFound.textContent = bits.join(" · ");
          els.callsignFound.hidden = bits.length === 0;
        }
        // Grid Square has no visible field, but keep populating the hidden
        // input so the QSO carries a grid (map plotting + ADIF GRIDSQUARE).
        /* No "only if empty" guard: the field is cleared whenever the callsign
           changes, so the newest lookup for the current callsign always wins. */
        if (result.grid && els.gridSquareInput) {
          els.gridSquareInput.value = result.grid;
        }
      } catch (error) {
        if (error.name === "AbortError") {
          return;
        }
        resetLookupUi(error.message);
      } finally {
        if (callsignLookupController === controller) {
          callsignLookupController = null;
        }
      }
    }

    // ── Logbooks (operations) ────────────────────────────────────────────────

    // Reflect the active logbook in the logger UI: title, form field visibility
    // (via data-logbook-type + CSS), field labels, and exchange seeding.
    function applyLogbookUi() {
      const book = logbook.active();
      if (!book || !els.logbookView) return;
      els.logbookView.dataset.logbookType = book.type;
      if (els.logbookTitle) els.logbookTitle.textContent = book.name;
      if (els.theirRefLabel) {
        els.theirRefLabel.textContent = book.type === "sota" ? "Their state / summit" : "Their state / park";
      }
      if (els.theirRefInput) {
        els.theirRefInput.placeholder = book.type === "sota" ? "MN or W7A/AE-001" : "MN or US-0001";
      }
      seedContestExchange();
    }

    // (Re)build the contest entry pad's exchange controls for the active
    // logbook: one received-exchange input per rcvd field (RST excluded — it
    // reuses #rst-received), plus the read-only sent-exchange hint chip.
    // Rebuilding clears the received inputs, which is exactly what rapid-log /
    // reset want for the next QSO. A no-op for non-contest logbooks.
    function seedContestExchange() {
      const contest = contestFor(logbook.active());
      if (els.contestExchRcvd) {
        els.contestExchRcvd.innerHTML = contest
          ? contest.rcvd
              .filter((k) => k !== "rst")
              .map((k) => {
                const f = EXCHANGE_FIELDS[k] || { label: k, ph: "" };
                return `<label class="wh-exch-field${f.wide ? " wide" : ""}">` +
                  `<span>${escapeHtml(f.label)}</span>` +
                  `<input data-exch-field="${escapeHtml(k)}" type="text" placeholder="${escapeHtml(f.ph)}" autocomplete="off" /></label>`;
              })
              .join("")
          : "";
      }
      updateSentExchangeChip();
    }

    // Read-only hint of the sent exchange as it will be logged: the auto serial
    // (if any) plus the logbook's fixed "my exchange" values. RST is omitted
    // (the operator sees it in the Signal Report Sent field).
    function updateSentExchangeChip() {
      if (!els.contestExchSent) return;
      const book = logbook.active();
      const contest = contestFor(book);
      if (!contest) {
        els.contestExchSent.hidden = true;
        els.contestExchSent.textContent = "";
        return;
      }
      const preview = contest.sent
        .filter((k) => k !== "rst")
        .map((k) => (k === "serial" ? nextSerial(book) : (book.meta?.exch?.[k] ?? "").toString().trim()))
        .filter(Boolean)
        .join(" ");
      els.contestExchSent.hidden = !preview;
      els.contestExchSent.textContent = preview ? `Sending: ${preview}` : "";
    }

    function showLogbookSelector() {
      if (els.logbookSelector) els.logbookSelector.hidden = false;
      if (els.logbookView) els.logbookView.hidden = true;
      renderLogbookList();
    }

    function openLogbook(id) {
      if (!logbook.open(id)) return;
      cancelFormEdit({ skipRender: true });
      if (els.logbookSelector) els.logbookSelector.hidden = true;
      if (els.logbookView) els.logbookView.hidden = false;
      applyLogbookUi();
      renderQsos();
    }

    function renderLogbookList() {
      if (!els.logbookList) return;
      els.logbookList.innerHTML = "";
      const activeId = logbook.active()?.id;
      logbook.list().forEach((book) => {
        const count = logbook.qsosFor(book.id).length;
        const card = document.createElement("div");
        card.className = `logbook-card${book.id === activeId ? " active" : ""}`;
        card.dataset.id = book.id;
        const detail = [
          book.meta?.ref,
          contestFor(book)?.name,
          `${count} contact${count === 1 ? "" : "s"}`,
          new Date(book.createdAt).toLocaleDateString()
        ].filter(Boolean).join(" • ");
        card.innerHTML = `
      <div class="logbook-card-main">
        <span class="logbook-type-badge logbook-type-${escapeHtml(book.type)}">${escapeHtml(LOGBOOK_TYPE_LABELS[book.type] || book.type)}</span>
        <div class="logbook-card-text">
          <strong>${escapeHtml(book.name)}</strong>
          <span class="logbook-card-detail">${escapeHtml(detail)}</span>
        </div>
      </div>
      <button type="button" class="logbook-delete-btn secondary" data-action="delete-logbook" title="Delete logbook" aria-label="Delete logbook">✕</button>`;
        els.logbookList.appendChild(card);
      });
    }

    function handleLogbookListClick(event) {
      const card = event.target.closest(".logbook-card");
      if (!card) return;
      const id = card.dataset.id;
      if (event.target.closest("[data-action='delete-logbook']")) {
        const book = logbook.list().find((b) => b.id === id);
        if (!book) return;
        if (!confirm(`Delete "${book.name}" and all its contacts? This cannot be undone.`)) return;
        const switchedActive = logbook.remove(id);
        if (switchedActive) {
          applyLogbookUi();
          renderQsos();
        }
        renderLogbookList();
        return;
      }
      openLogbook(id);
    }

    function updateLogbookCreateFormUi() {
      const type = els.logbookType?.value || "general";
      els.logbookTypeSeg?.querySelectorAll("button[data-type]").forEach((btn) => {
        btn.setAttribute("aria-pressed", btn.dataset.type === type ? "true" : "false");
      });
      if (els.logbookTypeHint) els.logbookTypeHint.textContent = LOGBOOK_TYPE_HINTS[type] || "";
      if (els.logbookRefRow) els.logbookRefRow.hidden = type !== "pota" && type !== "sota";
      if (els.logbookContestRow) els.logbookContestRow.hidden = type !== "contest";
      if (els.logbookRefLabel) els.logbookRefLabel.textContent = type === "sota" ? "Summit reference" : "Park reference";
      if (els.logbookRef) els.logbookRef.placeholder = type === "sota" ? "W7A/AE-001" : "US-0680";
      if (els.logbookNearbyResults) {
        els.logbookNearbyResults.hidden = true;
        els.logbookNearbyResults.innerHTML = "";
      }
      // Render one "my exchange" input per fixed sent field for the chosen
      // contest (the values that are constant for this logbook).
      const contest = CONTESTS.find((c) => c.id === els.logbookContest?.value);
      if (els.logbookExchMe) {
        els.logbookExchMe.innerHTML = (contest?.me || [])
          .map((k) => {
            const f = EXCHANGE_FIELDS[k] || { label: k, ph: "" };
            return `<label><span>${escapeHtml(f.label)}</span>` +
              `<input data-me-field="${escapeHtml(k)}" type="text" placeholder="${escapeHtml(f.ph)}" autocomplete="off" /></label>`;
          })
          .join("");
      }
      renderEntryCategoryFields();
    }

    // Build the entry-category dropdowns (CATEGORY-* from the Cabrillo catalog)
    // plus Location / Operators / Claimed score. Rendered once; each dropdown
    // defaults to "— not set —" so an untouched category writes no header. Same
    // for the three text fields — blank means the line is omitted.
    function renderEntryCategoryFields() {
      if (!els.logbookEntryCat || els.logbookEntryCat.childElementCount) return;
      const dropdowns = Object.entries(CABRILLO_CATEGORIES)
        .map(([key, def]) => {
          const opts = ['<option value="">— not set —</option>']
            .concat(def.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`))
            .join("");
          return `<label><span>${escapeHtml(def.label)}</span>` +
            `<select data-entry-field="${escapeHtml(key)}">${opts}</select></label>`;
        })
        .join("");
      const texts = [
        ["location", "Location (section)", "EMA"],
        ["operators", "Operators", "N0CALL"],
        ["claimedScore", "Claimed score", "12345"],
      ]
        .map(([k, label, ph]) =>
          `<label><span>${escapeHtml(label)}</span>` +
          `<input data-entry-field="${escapeHtml(k)}" type="text" placeholder="${escapeHtml(ph)}" autocomplete="off" /></label>`)
        .join("");
      els.logbookEntryCat.innerHTML = dropdowns + texts;
    }

    // Tab order for the entry pad, one main flow per logbook type (all mirror
    // General's shape) plus the shared top flow. See nextTabTarget in
    // js/utils.js for what the two flows mean and why they cannot be left to
    // the browser.
    //
    // Save Contact, Clear Form and the POTA/SOTA "More" toggle are deliberately
    // absent from every flow: Enter already submits the form from any field, and
    // a tab stop on a button means a stray Space mid-entry fires it (saving a
    // half-filled QSO, or just toggling More open/closed unexpectedly).
    //
    // Contest's list ends in a selector matched with querySelectorAll rather
    // than an id, because its received-exchange inputs are rebuilt per active
    // contest (js/apps/logger/index.js's seedContestExchange) — a fixed set of
    // ids cannot name them. flow() below treats every entry the same way
    // (always querySelectorAll, always flattened) so this needs no special case.
    const TAB_FLOW_MAIN = {
      general: ["#callsign", "#rst-sent", "#rst-received", "#their-location", "#rig", "#power", "#notes"],
      pota: ["#callsign", "#rst-sent", "#rst-received", "#their-ref", "#rig", "#power", "#notes"],
      sota: ["#callsign", "#rst-sent", "#rst-received", "#their-ref", "#rig", "#power", "#notes"],
      contest: ["#callsign", "#rst-sent", "#rst-received", "#contest-exch-rcvd input[data-exch-field]"],
    };
    const TAB_FLOW_TOP = ["#frequency", "#mode", "#qso-date", "#qso-time"];

    function bindEntryPadTabFlow() {
      if (!els.qsoForm) return;

      // Falls back to the General flow for any logbook type this map doesn't
      // name — which also covers a logbook with no type at all. initLogbooks
      // returns stored logbooks without normalising them, so a book written by
      // an older build can reach here with type === undefined; without this
      // fallback it would silently lose its tab order instead of getting
      // General's (the same field set styles.css gives it).
      const mainFlowFor = () => TAB_FLOW_MAIN[els.logbookView?.dataset.logbookType] || TAB_FLOW_MAIN.general;

      // offsetParent is null for display:none, which is how the pad-type CSS,
      // the mobile frequency/mode collapse, and POTA/SOTA's collapsed "More"
      // fields all hide elements — so filtering on it keeps every flow correct
      // without restating any of those rules here. querySelectorAll (not
      // querySelector) so one entry can stand for either a single id or
      // Contest's dynamic list of exchange inputs; for an id it just returns a
      // list of at most one.
      const resolveAll = (sel) =>
        Array.from(els.qsoForm.querySelectorAll(sel)).filter(
          (el) => !el.disabled && !el.readOnly && el.offsetParent !== null
        );
      const flow = (selectors) => selectors.flatMap(resolveAll);

      els.qsoForm.addEventListener("keydown", (event) => {
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const next = nextTabTarget({
          main: flow(mainFlowFor()),
          top: flow(TAB_FLOW_TOP),
          target: event.target,
          shift: event.shiftKey,
        });
        if (!next || next === event.target) return;
        event.preventDefault();
        next.focus();
      });

      // Every main flow wraps, which is what an operator wants mid-run but
      // would otherwise trap a keyboard-only user inside the pad with no way
      // out to the logbook table or the tab bar. Escape releases focus.
      els.qsoForm.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (event.target instanceof HTMLElement && els.qsoForm.contains(event.target)) {
          event.target.blur();
        }
      });
    }

    function createLogbook(event) {
      event.preventDefault();
      const name = els.logbookName?.value.trim();
      const type = els.logbookType?.value || "general";
      if (!name) return;
      const meta = {};
      if (type === "pota" || type === "sota") {
        const ref = els.logbookRef?.value.trim().toUpperCase();
        if (ref) meta.ref = ref;
      } else if (type === "contest") {
        const id = els.logbookContest?.value || "OTHER";
        meta.contest = id;
        const contest = CONTESTS.find((c) => c.id === id);
        const exch = {};
        (contest?.me || []).forEach((k) => {
          const v = els.logbookExchMe?.querySelector(`input[data-me-field="${k}"]`)?.value.trim();
          if (v) exch[k] = v;
        });
        meta.exch = exch;
        // Composed fixed-sent string kept for the legacy Cabrillo fallback.
        meta.exchSent = (contest?.me || []).map((k) => exch[k]).filter(Boolean).join(" ");
        // Entry category (Cabrillo CATEGORY-* / LOCATION / OPERATORS /
        // CLAIMED-SCORE). Only non-empty selections are stored, so an untouched
        // field emits no header at export time.
        const entry = {};
        els.logbookEntryCat?.querySelectorAll("[data-entry-field]").forEach((el) => {
          const v = el.value.trim();
          if (v) entry[el.dataset.entryField] = v;
        });
        if (Object.keys(entry).length) meta.entry = entry;
      }
      const book = logbook.create(name, type, meta);
      els.logbookCreateForm?.reset();
      if (els.logbookCreate) els.logbookCreate.hidden = true;
      openLogbook(book.id);
    }

    function populateContestSelect() {
      if (!els.logbookContest) return;
      els.logbookContest.innerHTML = CONTESTS
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
    }

    // Geolocate, then list the nearest POTA parks / SOTA summits as one-click
    // choices. Any failure falls back to the manual reference input.
    async function findNearbyRefs() {
      const type = els.logbookType?.value;
      const out = els.logbookNearbyResults;
      if (!out) return;
      out.hidden = false;
      out.textContent = "Locating…";
      try {
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 12000, maximumAge: 60000 })
        );
        const { latitude: lat, longitude: lon } = pos.coords;
        out.textContent = "Searching nearby…";
        const { potaRefs, sotaRefs } = await lookup.findNearbyRefs(lat, lon, type);
        const refs = type === "sota" ? sotaRefs : potaRefs;
        if (refs.length === 0) {
          out.textContent = "Nothing found nearby — enter the reference manually.";
          return;
        }
        out.innerHTML = "";
        refs.forEach((r) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "logbook-nearby-item secondary";
          btn.textContent = `${r.ref} — ${r.name}${Number.isFinite(r.km) ? ` (${r.km.toFixed(1)} km)` : ""}`;
          btn.addEventListener("click", () => {
            if (els.logbookRef) els.logbookRef.value = r.ref;
            if (els.logbookName && !els.logbookName.value.trim()) els.logbookName.value = r.name;
            out.hidden = true;
          });
          out.appendChild(btn);
        });
      } catch (error) {
        out.textContent = `Couldn't find nearby references (${error.message}) — enter it manually.`;
      }
    }

    // ── Cabrillo export (contest logbooks) ───────────────────────────────────

    function exportCabrillo() {
      const book = logbook.active();
      if (!book || book.type !== "contest") return;
      const blob = new Blob([logbook.toCabrillo(book)], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(settings.get().stationCall || "webham").toLowerCase()}-${(contestFor(book)?.id || "contest").toLowerCase()}.log`;
      anchor.click();
      URL.revokeObjectURL(url);
      appendSerialLog(`Exported ${logbook.qsos().length} contacts to Cabrillo.`);
    }

    // ── Table + mobile cards ─────────────────────────────────────────────────

    // Hourly rate over the last (up to) 10 QSOs, or null if not computable.
    function recentQsoPace() {
      const sorted = [...logbook.qsos()]
        .filter((q) => q.date && q.time)
        .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
      if (sorted.length < 2) return null;
      const window = sorted.slice(-10);
      const first = new Date(`${window[0].date}T${window[0].time}Z`);
      const last = new Date(`${window[window.length - 1].date}T${window[window.length - 1].time}Z`);
      const hours = (last - first) / 3600000;
      if (!(hours > 0)) return null;
      return Math.round((window.length - 1) / hours);
    }

    // Compact duration like "1h 12m" or "1d 19h" for the operation stat tile.
    function formatSpanShort(ms) {
      const minutes = Math.round(ms / 60000);
      if (minutes < 1) return "";
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ${minutes % 60}m`;
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }

    function relativeTimeAgo(iso) {
      const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
      if (minutes < 2) return "just now";
      if (minutes < 60) return `${minutes} minutes ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
      const days = Math.round(hours / 24);
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }

    // Operation sidebar: "this operation" facts + stat tiles, export note, LoTW note.
    function renderOperationSidebar() {
      const book = logbook.active();
      if (!book || !els.whOpFacts) return;
      const total = logbook.qsos().length;

      const facts = [];
      if (book.type === "pota" || book.type === "sota") {
        facts.push([book.type === "sota" ? "Summit" : "Park", book.meta?.ref || "—", "mono park"]);
      }
      const contest = contestFor(book);
      if (contest) {
        facts.push(["Contest", contest.name, ""]);
        if (book.meta?.exchSent) facts.push(["Exchange", book.meta.exchSent, "mono"]);
      }
      facts.push(["Contacts", String(total), ""]);
      const created = new Date(book.createdAt);
      const startedToday = created.toDateString() === new Date().toDateString();
      facts.push([
        "Started",
        startedToday
          ? `${String(created.getUTCHours()).padStart(2, "0")}:${String(created.getUTCMinutes()).padStart(2, "0")}Z today`
          : created.toLocaleDateString(),
        ""
      ]);
      els.whOpFacts.innerHTML = facts
        .map(([dt, dd, cls]) => `<dt>${escapeHtml(dt)}</dt><dd class="${cls}">${escapeHtml(dd)}</dd>`)
        .join("");

      if (els.whOpCount) els.whOpCount.textContent = String(total);
      if (els.whOpCountCaption) {
        const sorted = [...logbook.qsos()]
          .filter((q) => q.date && q.time)
          .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
        let span = "";
        if (sorted.length >= 2) {
          span = formatSpanShort(
            new Date(`${sorted[sorted.length - 1].date}T${sorted[sorted.length - 1].time}Z`) -
            new Date(`${sorted[0].date}T${sorted[0].time}Z`)
          );
        }
        els.whOpCountCaption.textContent = span ? `QSOs in ${span}` : "QSOs";
      }
      if (els.whOpPace) {
        const rate = recentQsoPace();
        els.whOpPace.innerHTML = rate === null ? "—" : `${rate}<span class="wh-op-unit"> /h</span>`;
      }

      if (els.whExportNote) {
        els.whExportNote.textContent = {
          pota: "ADIF works with POTA.app and every major logger.",
          sota: "ADIF works with the SOTA database and every major logger.",
          contest: "Cabrillo is the contest submission format.",
          general: "ADIF works with every major logger."
        }[book.type] || "";
      }

      if (els.whLotwNote) {
        const lastSync = localStorage.getItem(LOTW_SYNC_KEY);
        const confirmed = logbook.qsos().filter((q) => q.lotw_received === "Y").length;
        // Upload sends only what has not been sent, so say how much that is —
        // otherwise "Upload to LoTW" gives no clue what it is about to do.
        const pending = logbook.qsos().filter((q) => q.lotw_sent !== "Y").length;
        const lines = [lastSync ? `Last synced ${relativeTimeAgo(lastSync)}` : "Not synced yet"];
        lines.push(pending ? `${pending} of ${total} not uploaded` : "All contacts uploaded");
        if (confirmed) lines.push(`${confirmed} of ${total} confirmed`);
        els.whLotwNote.innerHTML = lines.map(escapeHtml).join("<br>");
      }
    }

    // Mobile card list: newest at the BOTTOM (nearest the pinned entry pad).
    function renderMobileQsoCards() {
      const wrap = document.querySelector("#mobile-qso-cards");
      if (!wrap) return;
      const sorted = [...logbook.qsos()].sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
      wrap.innerHTML = "";
      sorted.forEach((qso) => {
        const hz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
        const locKind = detectLocationKind(qso.theirLocation || qso.theirRef).kind;
        const locText = qso.theirLocation || qso.theirRef || qso.gridSquare || "";
        const meta = [
          qso.time ? `${qso.time}Z` : "",
          hz ? (hz / 1e6).toFixed(3) : "",
          [logbook.qsoBand(qso), qso.mode].filter(Boolean).join(" ")
        ].filter(Boolean).join(" · ");
        const card = document.createElement("div");
        card.className = "wh-mobile-qso-card";
        card.dataset.id = qso.id;
        card.innerHTML = `
      <div class="wh-mobile-qso-line1">
        <strong>${escapeHtml(qso.callsign || "")}</strong>${qso.isDupe ? '<span class="wh-dupe-pill-inline">dupe</span>' : ""}
        <span>${escapeHtml([qso.rstSent, qso.rstReceived].filter(Boolean).join(" / "))}</span>
      </div>
      <span class="wh-mobile-qso-line2">${escapeHtml(meta)}${locText ? ` · ${locKind === "park" ? `<strong class="wh-mobile-p2p">P2P ${escapeHtml(qso.parkName || locText)}</strong>` : escapeHtml(locText)}` : ""}</span>`;
        card.addEventListener("click", () => startFormEdit(qso.id));
        wrap.appendChild(card);
      });
      // Keep the newest entry visible next to the pad without scrolling the page.
      wrap.scrollTop = wrap.scrollHeight;
    }

    function renderQsos() {
      const query = els.searchInput.value.trim().toLowerCase();
      const bandFilter = els.loggerBandFilter?.value.trim().toLowerCase() || "";
      const modeFilter = els.loggerModeFilter?.value.trim().toLowerCase() || "";
      const lotwFilter = els.loggerLotwFilter?.value || "";
      const rows = logbook.qsos()
        .filter((qso) => {
          if (bandFilter) {
            const b = (qso.band || "").toLowerCase();
            if (!b.includes(bandFilter) && b !== bandFilter) {
              return false;
            }
          }
          if (modeFilter && (qso.mode || "").toLowerCase() !== modeFilter) {
            return false;
          }
          if (lotwFilter) {
            if (lotwFilter === "not-sent" && qso.lotw_sent === "Y") return false;
            if (lotwFilter === "sent" && qso.lotw_sent !== "Y") return false;
            if (lotwFilter === "confirmed" && qso.lotw_received !== "Y") return false;
          }
          if (!query) {
            return true;
          }

          return [
            qso.callsign,
            qso.operatorName,
            qso.mode,
            qso.band,
            qso.frequency,
            qso.notes,
            qso.gridSquare
          ]
            .join(" ")
            .toLowerCase()
            .includes(query);
        })
        .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));

      els.qsoTableBody.innerHTML = "";

      // Precompute dupes: a QSO is a dupe if an earlier QSO shares callsign +
      // band + mode + UTC day. NOTE: `isDupe` is set on the live QSO objects, so
      // it does round-trip through localStorage on the next commit — harmless
      // (it's recomputed here on every render), but see FOLLOWUPS.md to move it
      // to a render-local dupe-id set so storage stays clean.
      const seen = new Map();
      [...logbook.qsos()]
        .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
        .forEach((qso) => {
          const key = `${(qso.callsign || "").toUpperCase()}|${logbook.qsoBand(qso)}|${(qso.mode || "").toUpperCase()}|${qso.date}`;
          qso.isDupe = seen.has(key);
          if (!qso.isDupe) seen.set(key, qso.id);
        });

      rows.forEach((qso) => {
        const fragment = els.rowTemplate.content.cloneNode(true);
        const row = fragment.querySelector("tr");
        row.dataset.id = qso.id;

        if (qso.id === editingQsoId && editMode === "inline") {
          els.qsoTableBody.appendChild(fragment);
          buildInlineEditRow(row, qso);
          return;
        }

        fragment.querySelector('[data-field="datetime"]').textContent = `${qso.date} ${qso.time}Z`;
        const callCell = fragment.querySelector('[data-field="callsign"]');
        callCell.textContent = qso.callsign;
        if (qso.isDupe) {
          const pill = document.createElement("span");
          pill.className = "wh-dupe-pill-inline";
          pill.textContent = "dupe";
          callCell.appendChild(pill);
        }
        const freqCell = fragment.querySelector('[data-field="frequency"]');
        const hz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
        freqCell.textContent = hz ? `${(hz / 1e6).toFixed(3)} ` : "— ";
        const band = logbook.qsoBand(qso);
        if (band) {
          const suffix = document.createElement("span");
          suffix.style.cssText = "font-family: 'JetBrains Mono', monospace; font-size: .6rem; color: var(--muted);";
          suffix.textContent = band;
          freqCell.appendChild(suffix);
        }
        fragment.querySelector('[data-field="mode"]').textContent = qso.mode || "-";
        fragment.querySelector('[data-field="rst"]').textContent =
          [qso.rstSent, qso.rstReceived].filter(Boolean).join(" / ") || "-";
        const loc = fragment.querySelector('[data-field="location"]');
        if (loc) loc.textContent = qso.theirLocation || qso.theirRef || qso.gridSquare || "—";
        fragment.querySelector('[data-field="notes"]').textContent = qso.notes || "—";

        const lotwStatus = fragment.querySelector('[data-field="lotw-status"]');
        if (lotwStatus) {
          if (qso.lotw_received === "Y") {
            lotwStatus.innerHTML = '<span class="status-icon confirmed" title="LoTW Confirmed">L</span>';
          } else if (qso.lotw_sent === "Y") {
            lotwStatus.innerHTML = '<span class="status-icon sent" title="LoTW Sent">L</span>';
          } else {
            lotwStatus.textContent = "—";
          }
        }

        if (qso.id === editingQsoId && editMode === "form") {
          row.classList.add("wh-row-form-editing");
          callCell.append(" ✎");
        }

        els.qsoTableBody.appendChild(fragment);
      });

      renderMobileQsoCards();

      const total = logbook.qsos().length;
      els.emptyState.hidden = total > 0;
      els.qsoCount.textContent = String(total);
      if (els.whLogbookSubtitle) {
        const book = logbook.active();
        const context = book?.meta?.ref || contestFor(book)?.name || "";
        const parts = [context, `${total.toLocaleString()} contact${total === 1 ? "" : "s"}`];
        els.whLogbookSubtitle.textContent = parts.filter(Boolean).join(" • ");
      }
      // Mobile POTA/SOTA operation header: "<ref> · <N> QSOs" beside the name.
      if (els.whMobileOpMeta) {
        const book = logbook.active();
        const ref = book?.meta?.ref || "";
        els.whMobileOpMeta.textContent = [ref, `${total.toLocaleString()} QSO${total === 1 ? "" : "s"}`]
          .filter(Boolean).join(" · ");
      }
      updateMobileFreqSummary();
      if (els.whLogbookFooterRow && els.whLogbookTableFooter) {
        const show = rows.length > 0 && total > 0;
        els.whLogbookFooterRow.hidden = !show;
        els.whLogbookTableFooter.textContent = show
          ? `Showing ${rows.length} of ${total.toLocaleString()} contact${total === 1 ? "" : "s"}`
          : "";
      }
      renderOperationSidebar();
      // renderMap() (map-app-owned) used to run here unconditionally
      // on every renderQsos() call (filter keystrokes included, not just actual
      // QSO-list changes) — mirrored exactly via a bus dispatch so the map
      // app's "map-refresh" listener fires the same number of times, in the
      // same order.
      bus.dispatchEvent(new CustomEvent("map-refresh"));
    }

    // ── Logging flow polish: smart field, dupe, editing ─────────────────────

    // Kept here (not moved to js/utils.js) — every call site is logger-only,
    // and moving it to utils.js was tried and reverted (it made
    // utils.js a transitive dependency of js/connectors/cat.js through
    // logbook.js's localStorage.getItem() at module-eval time, breaking
    // test-cat-codecs.mjs). See that task's report for the full story.
    function detectLocationKind(raw) {
      const value = (raw || "").trim().toUpperCase();
      if (!value) return { kind: "", value };
      if (US_STATES[value]) return { kind: "state", value };
      if (PARK_REF_RE.test(value)) return { kind: "park", value };
      if (SUMMIT_REF_RE.test(value)) return { kind: "summit", value };
      return { kind: "other", value };
    }

    async function updateSmartFieldReadout() {
      const out = els.theirRefReadout;
      if (!out || !els.theirRefInput) return;
      const { kind, value } = detectLocationKind(els.theirRefInput.value);
      if (kind === "state") {
        out.hidden = false;
        out.dataset.kind = "state";
        out.innerHTML = `<span class="wh-smart-field-pill">state</span><span>${escapeHtml(US_STATES[value])} — logged as their state</span>`;
        return;
      }
      if (kind === "park") {
        out.hidden = false;
        out.dataset.kind = "park";
        out.innerHTML = `<span class="wh-smart-field-pill">p2p</span><span>Park detected — looking up…</span>`;
        const name = await lookup.lookupParkName(value);
        // Input may have changed while the fetch was in flight.
        if (detectLocationKind(els.theirRefInput.value).value !== value) return;
        out.innerHTML = `<span class="wh-smart-field-pill">p2p</span><span>Park detected${name ? ` — <strong>${escapeHtml(name)}</strong>` : ""}</span>`;
        return;
      }
      if (kind === "summit") {
        out.hidden = false;
        out.dataset.kind = "park";
        out.innerHTML = `<span class="wh-smart-field-pill">s2s</span><span>Summit detected — <strong>${escapeHtml(value)}</strong></span>`;
        return;
      }
      out.hidden = true;
      out.innerHTML = "";
    }

    function updateDupeBanner() {
      if (!els.dupeBanner) return;
      const dupe = logbook.findDupe(
        els.callsignInput?.value,
        els.bandInput?.value,
        document.querySelector("#mode")?.value,
        els.qsoDate?.value,
        editingQsoId
      );
      if (!dupe) {
        els.dupeBanner.hidden = true;
        return;
      }
      els.dupeBanner.hidden = false;
      els.dupeBannerText.innerHTML =
        `You already worked <strong style="font-family: 'JetBrains Mono', monospace;">${escapeHtml(dupe.callsign)}</strong> ` +
        `on ${escapeHtml(dupe.band || logbook.qsoBand(dupe))} ${escapeHtml(dupe.mode || "")} today at ${escapeHtml(dupe.time || "?")}Z. ` +
        `You can still save it — it just won't count again.`;
    }

    // ── Two-level QSO editing ────────────────────────────────────────────────

    function startInlineEdit(id) {
      cancelFormEdit({ skipRender: true });
      editingQsoId = id;
      editMode = "inline";
      renderQsos();
    }

    function startFormEdit(id) {
      const qso = logbook.findById(id);
      if (!qso) return;
      editingQsoId = id;
      editMode = "form";
      if (els.callsignInput) els.callsignInput.value = qso.callsign || "";
      if (els.qsoDate) els.qsoDate.value = qso.date || "";
      if (els.qsoTime) els.qsoTime.value = qso.time || "";
      if (els.frequencyInput) {
        const hz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
        els.frequencyInput.value = hz ? (hz / 1e6).toFixed(3) : "";
      }
      cat.setFreqFollow(false);
      updateFreqBandChip();
      if (!els.bandInput.value && qso.band) els.bandInput.value = qso.band;
      const setVal = (sel, v) => { const el = document.querySelector(sel); if (el) el.value = v || ""; };
      cat.setModeFollow(false);
      setVal("#mode", qso.mode);
      updateModeQuickButtons();
      applyModeReportHints();
      setVal("#rst-sent", qso.rstSent);
      setVal("#rst-received", qso.rstReceived);
      setVal("#power", qso.power);
      setVal("#rig", qso.rig);
      setVal("#notes", qso.notes);
      // Hidden grid field (no visible input) — preserve the QSO's grid on edit
      // so re-saving keeps it plotting on the map / exporting GRIDSQUARE.
      setVal("#grid-square", qso.gridSquare);
      if (els.theirRefInput) els.theirRefInput.value = qso.theirLocation || qso.theirRef || "";
      if (els.theirLocationInput) els.theirLocationInput.value = qso.theirLocation || "";
      // Contest: repopulate the dynamic received-exchange inputs from the QSO's
      // stored per-field values, and refresh the sent-exchange hint chip.
      const rcvdVals = qso.exchFields?.rcvd || {};
      els.contestExchRcvd?.querySelectorAll("input[data-exch-field]").forEach((inp) => {
        inp.value = rcvdVals[inp.dataset.exchField] || "";
      });
      updateSentExchangeChip();
      void updateSmartFieldReadout();
      updateDupeBanner();
      if (els.qsoFormHeading) els.qsoFormHeading.textContent = `Editing ${qso.callsign || ""}`;
      if (els.qsoFormBadge) {
        els.qsoFormBadge.textContent = `logged ${(qso.time || "").replace(":", ":")}Z`;
        els.qsoFormBadge.classList.add("wh-editing-badge");
        els.qsoFormBadge.classList.remove("muted");
      }
      if (els.qsoFormSubmit) els.qsoFormSubmit.textContent = "Update Contact";
      if (els.resetFormBtn) els.resetFormBtn.textContent = els.resetFormBtn.dataset.labelEdit || "Cancel";
      if (els.deleteQsoBtn) els.deleteQsoBtn.hidden = false;
      els.qsoFormCard?.classList.add("wh-form-editing");
      renderQsos();
      els.qsoFormCard?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    /* `skipRender` only skips the QSO-table repaint (callers that pass it do their
       own). It used to be `keepForm`, which also left the form fully populated —
       so switching from form-edit to an inline edit, changing logbooks, or
       deleting the edited QSO dropped out of edit mode while still holding the
       old contact's callsign AND its hidden grid. Typing a new callsign over that
       and saving created a QSO carrying the previous station's location. */
    function cancelFormEdit({ skipRender = false } = {}) {
      const wasEditing = editingQsoId !== null;
      editingQsoId = null;
      editMode = null;
      if (els.qsoFormHeading) els.qsoFormHeading.textContent = "New contact";
      if (els.qsoFormBadge) {
        els.qsoFormBadge.textContent = "Stored in your browser";
        els.qsoFormBadge.classList.remove("wh-editing-badge");
        els.qsoFormBadge.classList.add("muted");
      }
      if (els.qsoFormSubmit) els.qsoFormSubmit.textContent = "Save Contact";
      if (els.resetFormBtn) els.resetFormBtn.textContent = els.resetFormBtn.dataset.labelNew || "Clear Form";
      if (els.deleteQsoBtn) els.deleteQsoBtn.hidden = true;
      els.qsoFormCard?.classList.remove("wh-form-editing");
      if (wasEditing) {
        els.qsoForm?.reset();
        clearHiddenGrid();
        seedQsoDefaults();
        updateFreqBandChip();
        updateModeQuickButtons();
        setMfreqEditing(false);
        void updateSmartFieldReadout();
        updateDupeBanner();
        if (!skipRender) renderQsos();
      }
    }

    // Single-click starts inline edit after a short delay; a double-click within
    // the window cancels it and opens the form editor instead.
    function handleRowClickTiming(event) {
      const row = event.target.closest("tr[data-id]");
      if (!row) return;
      // Ignore clicks on action buttons and on inline-edit inputs.
      if (event.target.closest("button, input, a")) return;
      const id = row.dataset.id;
      clearTimeout(rowClickTimer);
      rowClickTimer = setTimeout(() => startInlineEdit(id), 250);
    }

    function handleRowDblClick(event) {
      const row = event.target.closest("tr[data-id]");
      if (!row) return;
      if (event.target.closest("button, input, a")) return;
      clearTimeout(rowClickTimer);
      if (editMode === "inline") {
        editingQsoId = null;
        editMode = null;
      }
      startFormEdit(row.dataset.id);
    }

    function commitInlineEdit(row) {
      const qso = logbook.findById(editingQsoId);
      if (!qso) return;
      const get = (name) => row.querySelector(`[data-edit="${name}"]`)?.value ?? "";
      qso.callsign = get("callsign").trim().toUpperCase();
      const freqRaw = get("frequency").trim();
      const hz = freqRaw ? parseFrequencyText(freqRaw) : 0;
      qso.frequency = freqRaw;
      qso.band = hz ? inferBandFromFrequency(hz) : qso.band || "";
      qso.mode = get("mode").trim().toUpperCase();
      qso.rstSent = get("rst-sent").trim();
      qso.rstReceived = get("rst-received").trim();
      const loc = detectLocationKind(get("location"));
      qso.theirLocation = loc.value;
      qso.theirRef = loc.kind === "park" ? loc.value : "";
      qso.locationKind = loc.kind;
      logbook.persist();
      editingQsoId = null;
      editMode = null;
      renderQsos();
    }

    function cancelInlineEdit() {
      editingQsoId = null;
      editMode = null;
      renderQsos();
    }

    // Build the inline quick-edit cells for a QSO (single-click edit).
    function buildInlineEditRow(row, qso) {
      row.classList.add("wh-row-editing");
      const freqHz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
      row.innerHTML = `
    <td style="color: var(--muted); font-size: .76rem;">${escapeHtml(qso.date || "")} ${escapeHtml(qso.time || "")}Z</td>
    <td><input type="text" data-edit="callsign" class="wh-edit-callsign" value="${escapeHtml(qso.callsign || "")}"></td>
    <td><input type="text" data-edit="frequency" style="font-family: 'JetBrains Mono', monospace;" value="${escapeHtml(freqHz ? (freqHz / 1e6).toFixed(3) : "")}"></td>
    <td><input type="text" data-edit="mode" value="${escapeHtml(qso.mode || "")}"></td>
    <td style="white-space: nowrap;"><span style="display: inline-flex; gap: .25rem;"><input type="text" data-edit="rst-sent" style="width: 2.6rem;" value="${escapeHtml(qso.rstSent || "")}"><input type="text" data-edit="rst-received" style="width: 2.6rem;" value="${escapeHtml(qso.rstReceived || "")}"></span></td>
    <td><input type="text" data-edit="location" style="text-transform: uppercase; font-family: 'JetBrains Mono', monospace;" value="${escapeHtml(qso.theirLocation || qso.theirRef || qso.gridSquare || "")}"></td>
    <td colspan="2">
      <div class="wh-row-edit-actions">
        <button type="button" data-action="inline-save">Save</button>
        <button type="button" class="secondary" data-action="inline-cancel" aria-label="Cancel edit">✕</button>
      </div>
    </td>`;
      row.querySelector("[data-edit='callsign']")?.focus();
    }

    // ── Save / build / table actions ─────────────────────────────────────────

    async function saveQso(event) {
      event.preventDefault();

      if (editingQsoId && editMode === "form") {
        const existing = logbook.findById(editingQsoId);
        if (existing) {
          const updated = buildQsoFromForm();
          updated.id = existing.id;
          updated.lotw_sent = existing.lotw_sent;
          updated.lotw_received = existing.lotw_received;
          Object.assign(existing, updated);
          logbook.persist();
        }
        cancelFormEdit();
        return;
      }

      const qso = buildQsoFromForm();
      logbook.commit(qso);
    }

    function buildQsoFromForm() {
      const formData = new FormData(els.qsoForm);
      const qso = Object.fromEntries(formData.entries());
      qso.id = crypto.randomUUID();
      qso.rig = qso.rig || cat.getProfile().name;
      // Normalize frequency to a plain MHz string; band derives from it.
      const hz = qso.frequency ? parseFrequencyText(qso.frequency) : 0;
      if (hz) {
        qso.frequency = (hz / 1e6).toFixed(3);
        qso.band = inferBandFromFrequency(hz);
      }
      // Mobile pad hides date/time — stamp them at save from UTC now.
      if (els.qsoDate && els.qsoDate.offsetParent === null) {
        const now = new Date();
        qso.date = now.toISOString().slice(0, 10);
        qso.time = now.toISOString().slice(11, 16);
      }
      // Location: POTA/SOTA logbooks use the smart "their state/park" field
      // (#their-ref); the general logbook uses the plain Location field
      // (#their-location, name="theirLocation"). Only one is visible per mode,
      // so whichever is filled wins. detectLocationKind still classifies it
      // (state/park/summit/other) so a general-log grid or state is recognized.
      const loc = detectLocationKind(qso.theirRef || qso.theirLocation);
      qso.theirLocation = loc.value;
      qso.locationKind = loc.kind;
      qso.parkName = loc.kind === "park" ? lookup.peekParkName(loc.value) : "";
      // Only park/summit refs flow into ADIF SIG_INFO / SOTA_REF.
      qso.theirRef = loc.kind === "park" || loc.kind === "summit" ? loc.value : "";

      // Contest: compose the sent/rcvd exchange strings from the active
      // contest's field templates. Sent = auto serial + fixed "my exchange"
      // (RST from the report field); rcvd = RST + the dynamic per-QSO inputs.
      // Per-field received values are stored on the QSO so an edit repopulates
      // the inputs; the sent serial is preserved across edits.
      const book = logbook.active();
      const contest = contestFor(book);
      if (contest) {
        const rcvdValues = {};
        els.contestExchRcvd?.querySelectorAll("input[data-exch-field]").forEach((inp) => {
          rcvdValues[inp.dataset.exchField] = inp.value.trim();
        });
        let serial = nextSerial(book);
        if (editMode === "form" && editingQsoId) {
          const prior = logbook.findById(editingQsoId)?.exchFields?.sent?.serial;
          if (prior) serial = prior;
        }
        // Exclude rst from the composed exchange strings: RST already has its
        // own Cabrillo column / ADIF RST_SENT|RST_RCVD field, so including it
        // here would double-print it. This matches the sent-chip preview, which
        // also filters rst.
        qso.exchSent = composeExchange(contest.sent.filter((k) => k !== "rst"), { serial, ...(book.meta?.exch || {}) });
        qso.exchRcvd = composeExchange(contest.rcvd.filter((k) => k !== "rst"), rcvdValues);
        qso.exchFields = { sent: { serial }, rcvd: rcvdValues };
      }
      return qso;
    }

    function handleTableClick(event) {
      // The per-row Delete/Sent actions were removed from the table; deletion is
      // now via the entry-pad Delete button (row-click opens the contact for
      // editing, which reveals it). Only the inline-edit Save/Cancel remain.
      const inlineSave = event.target.closest("[data-action='inline-save']");
      const inlineCancel = event.target.closest("[data-action='inline-cancel']");

      if (inlineSave) {
        commitInlineEdit(inlineSave.closest("tr"));
        return;
      }
      if (inlineCancel) {
        cancelInlineEdit();
        return;
      }

      handleRowClickTiming(event);
    }

    // ── Export + LoTW ─────────────────────────────────────────────────────────

    function exportAdif() {
      const adif = logbook.toAdif();
      const blob = new Blob([adif], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const book = logbook.active();
      const date = new Date().toISOString().slice(0, 10);
      // POTA convention: CALLSIGN@PARK-YYYYMMDD.adi, ready for pota.app upload
      anchor.download = (book?.type === "pota" || book?.type === "sota") && book.meta?.ref
        ? `${(settings.get().stationCall || "MYCALL").toUpperCase()}@${book.meta.ref.replace(/[\\/]/g, "-")}-${date.replace(/-/g, "")}.adi`
        : `webham-log-${date}.adi`;
      anchor.click();
      URL.revokeObjectURL(url);
      appendSerialLog(`Exported ${logbook.qsos().length} contacts to ADIF.`);
    }

    function setLotwStatus(text, kind = "") {
      if (!els.lotwStatus) return;
      clearTimeout(lotwStatusTimer);
      els.lotwStatus.textContent = text;
      els.lotwStatus.className = `lotw-status-msg${kind ? " " + kind : ""}`;
      if (kind === "ok" || kind === "err") {
        lotwStatusTimer = setTimeout(() => {
          if (els.lotwStatus) els.lotwStatus.textContent = "";
        }, 6000);
      }
    }

    async function signAndUploadToLotw() {
      const s = settings.get();
      const login = s.lotwUser;
      const password = getSecret("lotwPass");
      const p12Meta = getLotwP12Meta();
      if (!login || !password) {
        setLotwStatus("Set username and password in Settings first.", "err");
        return;
      }
      if (!p12Meta) {
        setLotwStatus("Attach a .p12 certificate in Settings first.", "err");
        return;
      }
      if (logbook.qsos().length === 0) {
        setLotwStatus("No contacts to upload.", "err");
        return;
      }
      // Upload what LoTW has not already been sent, not the whole logbook.
      // Re-sending accepted QSOs costs a signature each on the way out and is
      // discarded as a duplicate on the way in; on a hosted deployment it is
      // also what pushes a long log past the per-request QSO cap. Operators who
      // need to re-send a QSO can clear its sent flag from the log table.
      const pending = logbook.qsos().filter((qso) => qso.lotw_sent !== "Y");
      if (pending.length === 0) {
        setLotwStatus("Every contact has already been uploaded to LoTW.", "ok");
        return;
      }
      if (els.lotwSignUploadBtn) els.lotwSignUploadBtn.disabled = true;
      setLotwStatus(`Signing ${pending.length} QSOs…`, "busy");
      try {
        const response = await fetch("/api/lotw/sign-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            login: login.trim(),
            password,
            p12Base64: p12Meta.data,
            p12Pass: getSecret("lotwP12Pass"),
            gridsquare: s.ft8MyGrid || "",
            adif: logbook.toAdif(pending)
          })
        });
        const responseText = await response.text();
        let payload;
        try {
          payload = JSON.parse(responseText);
        } catch {
          throw new Error(`Server error (${response.status}): ${responseText.slice(0, 120)}`);
        }
        if (!response.ok) throw new Error(payload.error || "LoTW sign and upload failed.");
        // A 2xx without a message would otherwise throw here and be reported as a
        // failed upload, after ARRL had already accepted the log.
        const message = payload.message || "accepted";
        setLotwStatus(`Uploaded ${pending.length} QSOs — ${message.slice(0, 60)}`, "ok");
        appendSerialLog(`LoTW upload: ${pending.length} QSOs — ${message}`);
        // Only the QSOs in this upload. Marking the whole logbook would hide any
        // contact that was excluded, and it would never be offered again.
        pending.forEach(qso => { qso.lotw_sent = "Y"; });
        logbook.persist();
        renderQsos();
        renderOperationSidebar();
      } catch (error) {
        setLotwStatus(`Upload failed: ${error.message}`, "err");
        appendSerialLog(`LoTW upload failed: ${error.message}`);
      } finally {
        if (els.lotwSignUploadBtn) els.lotwSignUploadBtn.disabled = false;
      }
    }

    // Syncing pulls LoTW's confirmation report and folds it into the log's
    // sent/confirmed columns. It does NOT hand the operator a file: the report
    // is a means to updating the log, not a deliverable, and the .adi that used
    // to land in the downloads folder on every sync was a leftover from when
    // this button was "Download LoTW report".
    //
    // Two things keep the traffic to ARRL honest, both from
    // docs/lotw-rate-limits.md: the query is incremental once a cursor exists
    // (functions/_lib/lotw-query.js), and back-to-back syncs are refused here.
    async function syncLotw() {
      const s = settings.get();
      const login = s.lotwUser;
      const password = getSecret("lotwPass");
      if (!login || !password) {
        setLotwStatus("Set username and password in Settings first.", "err");
        return;
      }

      // LoTW allows one download at a time per account and runs an abuse
      // detector on top of that, so a re-sync moments after the last one can
      // only cost the operator their next sync. Nothing arrives that fast: a
      // confirmation needs the other station to upload first.
      const lastSync = Date.parse(localStorage.getItem(LOTW_SYNC_KEY) || "");
      const sinceLast = Number.isFinite(lastSync) ? Date.now() - lastSync : Infinity;
      if (sinceLast < LOTW_SYNC_COOLDOWN_MS) {
        const wait = Math.ceil((LOTW_SYNC_COOLDOWN_MS - sinceLast) / 60000);
        setLotwStatus(`Synced less than ${LOTW_SYNC_COOLDOWN_MS / 60000} minutes ago — try again in ${wait} min.`, "err");
        return;
      }

      const qslSince = localStorage.getItem(LOTW_CURSOR_KEY) || "";
      if (els.lotwDownloadBtn) els.lotwDownloadBtn.disabled = true;
      setLotwStatus(qslSince ? "Checking LoTW for new confirmations…" : "Fetching your LoTW log…", "busy");

      try {
        const response = await fetch("/api/lotw/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ login: login.trim(), password, qslSince })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "LoTW sync failed.");

        const lotwRecords = logbook.parseAdif(payload.adif || "");
        // An incremental report asks LoTW for confirmations only, so every
        // record in it is one — QSL_RCVD is checked as well for the full first
        // pull, which returns every QSO whether confirmed or not.
        const allConfirmed = !payload.full;
        let matchCount = 0;
        let newlyConfirmed = 0;
        const matchedQsoIds = new Set();
        for (const record of lotwRecords) {
          const qso = logbook.findMatchingQso(record, matchedQsoIds);
          if (!qso) continue;
          matchedQsoIds.add(qso.id);
          qso.lotw_sent = "Y";
          if (allConfirmed || record.QSL_RCVD === "Y") {
            if (qso.lotw_received !== "Y") newlyConfirmed++;
            qso.lotw_received = "Y";
          }
          matchCount++;
        }
        if (matchCount > 0) {
          logbook.persist();
          renderQsos();
        }

        // Advance the cursor so the next sync asks only for what changed after
        // this report. An empty report can omit the field; keeping the old
        // cursor is right, and dropping it would force a full pull next time.
        if (payload.lastQsl) localStorage.setItem(LOTW_CURSOR_KEY, payload.lastQsl);
        localStorage.setItem(LOTW_SYNC_KEY, new Date().toISOString());

        const confirmed = logbook.qsos().filter(q => q.lotw_received === "Y").length;
        renderOperationSidebar();
        const headline = newlyConfirmed > 0
          ? `${newlyConfirmed} new confirmation${newlyConfirmed === 1 ? "" : "s"}`
          : "no new confirmations";
        setLotwStatus(`Synced — ${headline}, ${confirmed} confirmed total`, "ok");
        appendSerialLog(
          `LoTW sync (${payload.full ? "full" : "incremental"}): ` +
          `${lotwRecords.length} records, ${matchCount} matched, ${newlyConfirmed} newly confirmed, ${confirmed} confirmed total.`
        );

        // A record LoTW holds that nothing in the log matches is worth saying
        // out loud — it usually means a QSO was logged with a different time or
        // band, and it would otherwise look like the sync simply did nothing.
        const unmatched = lotwRecords.length - matchCount;
        if (unmatched > 0) {
          appendSerialLog(`LoTW sync: ${unmatched} LoTW record(s) matched no logged contact.`);
        }
      } catch (error) {
        setLotwStatus(`Sync failed: ${error.message}`, "err");
        appendSerialLog(`LoTW sync failed: ${error.message}`);
      } finally {
        if (els.lotwDownloadBtn) els.lotwDownloadBtn.disabled = false;
      }
    }

    // ── POTA spot prefill ─────────────────────────────────────────────────────

    // FT8's index.js dispatches two single-purpose bus events after
    // moving applyFt8Defaults/syncFt8ToLog off direct DOM pokes into this tab
    // and off ctx.logger.seedDateTime() — see this file's header note. These
    // were one overloaded "ft8-log" event whose detail shape diverged by a
    // `kind` discriminant; split per PR #41 into a fixed shape per event.
    //   - "ft8-log-defaults" (the ft8-fill-frequency-btn handler) fills the
    //     frequency/band/mode fields.
    //   - "ft8-log-exchange" (the ft8-sync-log-btn handler and
    //     captureFt8QsoSnapshot) cross-fills the current FT8 exchange
    //     (callsign/grid/reports/notes) and seeds the date/time.
    // The frequency/band/mode fill is shared between the two: an exchange
    // snapshot carries mode and frequency too, and never a band.
    function applyFt8FreqBandMode(detail) {
      if (detail.band !== undefined) document.querySelector("#band").value = detail.band;
      if (detail.mode !== undefined) { document.querySelector("#mode").value = detail.mode; applyModeReportHints(); }
      if (detail.frequency !== undefined) document.querySelector("#frequency").value = detail.frequency;
    }
    function applyFt8LogExchange(detail) {
      applyFt8FreqBandMode(detail);
      document.querySelector("#callsign").value = detail.callsign;
      document.querySelector("#rst-sent").value = detail.rstSent;
      document.querySelector("#rst-received").value = detail.rstReceived;
      document.querySelector("#notes").value = detail.notes;
      // Hidden grid field — carry the DX grid from the FT8 decode so the
      // logged QSO plots on the map / exports GRIDSQUARE.
      document.querySelector("#grid-square").value = detail.gridSquare || "";
      seedDateTime();
    }

    function prefillSpotLog(spot) {
      document.querySelector("#callsign").value = spot.activator;
      document.querySelector("#mode").value = spot.mode || "";
      updateModeQuickButtons();
      applyModeReportHints();
      document.querySelector("#frequency").value = spot.frequencyText || "";
      document.querySelector("#band").value = inferBandFromFrequency(spot.frequencyHz);
      // Hidden grid field — carry the spot's grid so the QSO plots on the map.
      document.querySelector("#grid-square").value = spot.grid || "";
      document.querySelector("#notes").value = [
        spot.reference ? `POTA ${spot.reference}` : "",
        spot.parkName,
        spot.locationDesc,
        spot.comments
      ]
        .filter(Boolean)
        .join(" | ");
      seedDateTime();
    }

    // ====== Wiring ======
    const safeBind = (el, event, handler) => {
      if (el) el.addEventListener(event, handler);
    };

    safeBind(els.resetFormBtn, "click", () => {
      if (editingQsoId) {
        cancelFormEdit();
        return;
      }
      if (els.qsoForm) els.qsoForm.reset();
      clearHiddenGrid();
      seedQsoDefaults();
      resetLookupUi("Type a callsign to lookup");
    });
    safeBind(els.potaMoreToggle, "click", () => {
      const open = els.qsoFormCard.classList.toggle("wh-more-open");
      els.potaMoreToggle.setAttribute("aria-expanded", String(open));
      els.potaMoreToggle.firstChild.textContent = open ? "Less " : "More ";
    });
    safeBind(els.deleteQsoBtn, "click", () => {
      if (!editingQsoId) return;
      if (!confirm("Delete this contact? This cannot be undone.")) return;
      logbook.deleteQso(editingQsoId);
      cancelFormEdit();
      renderQsos();
    });
    safeBind(els.callsignInput, "input", handleCallsignInputChange);
    safeBind(els.callsignInput, "input", updateDupeBanner);
    safeBind(document.querySelector("#mode"), "input", updateDupeBanner);
    safeBind(document.querySelector("#mode"), "input", applyModeReportHints);
    // Mobile POTA/SOTA (7c): the compact freq/band/mode summary. Tapping it
    // reveals the real inputs; keep the summary text in sync as freq/mode change
    // and whenever the shared band chip refreshes (CAT tune, band quick-set).
    safeBind(els.mfreqSummary, "click", () => setMfreqEditing(true));
    safeBind(els.mfreqSummary, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setMfreqEditing(true); }
    });
    safeBind(els.frequencyInput, "input", updateMobileFreqSummary);
    safeBind(document.querySelector("#mode"), "input", updateMobileFreqSummary);
    bus.addEventListener("freq-band-chip-refresh", () => updateMobileFreqSummary());
    safeBind(els.theirRefInput, "input", () => {
      els.theirRefInput.value = els.theirRefInput.value.toUpperCase();
      void updateSmartFieldReadout();
    });
    // General logbook Location field: uppercase live so a typed grid/state
    // matches how it is stored (detectLocationKind uppercases at save anyway).
    safeBind(els.theirLocationInput, "input", () => {
      els.theirLocationInput.value = els.theirLocationInput.value.toUpperCase();
    });
    safeBind(els.qsoTableBody, "dblclick", handleRowDblClick);
    safeBind(els.qsoTableBody, "keydown", (event) => {
      if (editMode !== "inline") return;
      if (event.key === "Enter") {
        event.preventDefault();
        const row = event.target.closest("tr");
        if (row) commitInlineEdit(row);
      } else if (event.key === "Escape") {
        cancelInlineEdit();
      }
    });
    safeBind(els.qsoForm, "submit", saveQso);
    bindEntryPadTabFlow();

    // A QSO that could not be written to disk. The connector still holds it in
    // memory and the table still shows it, so the operator can export ADIF and
    // keep it — but they have to be told, loudly, because the form clears and
    // everything otherwise looks like a normal save. Uses alert() deliberately:
    // this is the one failure in WebHam that loses a contact, and a status line
    // in the corner is not enough during a run.
    logbook.addEventListener("persist-failed", (e) => {
      appendSerialLog(`LOGBOOK NOT SAVED: ${e.detail}`);
      window.alert(e.detail);
    });

    // Connector event seam: logbook.commit() is the only method that
    // dispatches "change"; this listener is the exact UI tail the old
    // commitQso() ran after `state.qsos.push(qso); persistQsos();`.
    logbook.addEventListener("change", () => {
      renderQsos();
      // Rapid logging: frequency and mode carry over to the next contact;
      // callsign, reports, and the smart field reset (reports back to 59/59).
      const keepFreq = els.frequencyInput?.value || "";
      const keepMode = document.querySelector("#mode")?.value || "";
      els.qsoForm.reset();
      clearHiddenGrid();
      seedQsoDefaults();
      if (els.frequencyInput && keepFreq) els.frequencyInput.value = keepFreq;
      if (keepMode) document.querySelector("#mode").value = keepMode;
      applyModeReportHints();
      // Carry over a sensible report default: RST "59" on phone/CW; on digital
      // leave it blank so the dB placeholder shows (FT8 auto-log fills the SNR).
      const digital = isDigitalMode(keepMode);
      const rstS = document.querySelector("#rst-sent");
      const rstR = document.querySelector("#rst-received");
      if (rstS) rstS.value = digital ? "" : "59";
      if (rstR) rstR.value = digital ? "" : "59";
      updateFreqBandChip();
      updateModeQuickButtons();
      setMfreqEditing(false);
      void updateSmartFieldReadout();
      updateDupeBanner();
      syncRadioConsole();
    });

    safeBind(els.logbookBackBtn, "click", showLogbookSelector);
    safeBind(els.logbookNewBtn, "click", () => {
      if (!els.logbookCreate) return;
      els.logbookCreate.hidden = !els.logbookCreate.hidden;
      updateLogbookCreateFormUi();
      if (!els.logbookCreate.hidden) els.logbookName?.focus();
    });
    safeBind(els.logbookCreateCancel, "click", () => {
      if (els.logbookCreate) els.logbookCreate.hidden = true;
    });
    safeBind(els.logbookTypeSeg, "click", (event) => {
      const btn = event.target.closest("button[data-type]");
      if (!btn || !els.logbookType) return;
      els.logbookType.value = btn.dataset.type;
      updateLogbookCreateFormUi();
    });
    safeBind(els.logbookContest, "change", updateLogbookCreateFormUi);
    safeBind(els.logbookNearbyBtn, "click", () => { void findNearbyRefs(); });
    safeBind(els.logbookCreateForm, "submit", createLogbook);
    safeBind(els.logbookList, "click", handleLogbookListClick);
    safeBind(els.exportCabrilloBtn, "click", exportCabrillo);
    safeBind(els.searchInput, "input", renderQsos);
    safeBind(els.loggerBandFilter, "change", renderQsos);
    safeBind(els.loggerModeFilter, "change", renderQsos);
    safeBind(els.loggerLotwFilter, "change", renderQsos);
    safeBind(els.whAddEntry, "click", focusLogbookEntry);
    safeBind(els.whNewQso, "click", focusLogbookEntry);
    safeBind(els.loggerFilterToggle, "click", () => {
      const row = document.querySelector(".wh-entry-section");
      row?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    safeBind(els.exportAdifBtn, "click", exportAdif);
    safeBind(els.lotwDownloadBtn, "click", () => { void syncLotw(); });
    safeBind(els.lotwSignUploadBtn, "click", () => { void signAndUploadToLotw(); });
    safeBind(els.qsoTableBody, "click", handleTableClick);

    // focusLogbookEntry used to call the monolith's same-module activateTab("logger")
    // directly (the tab-panel/tab-button-toggling shell function, which
    // a shell-level concern outside
    // this task's scope, not in the move list). New bus seam: this dispatches
    // "activate-tab" and js/shell/shell.js's own listener calls the real
    // activateTab(e.detail) — same shape as every other "app needs a
    // function that lives elsewhere" seam in this codebase. The scroll/focus
    // tail (unique to this button, not part of activateTab itself) still
    // runs locally afterward, byte-identical to the original.
    function focusLogbookEntry() {
      bus.dispatchEvent(new CustomEvent("activate-tab", { detail: "logger" }));
      window.requestAnimationFrame(() => {
        document.querySelector(".wh-entry-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
        els.callsignInput?.focus();
      });
    }

    // bus seams: js/apps/spots/index.js and js/apps/map/index.js dispatch
    // "prefill-log" for this app's own same-module prefillSpotLog (they no
    // longer have one to call directly). js/apps/radio/index.js dispatches
    // "radio-profile-changed"/"dupe-banner-refresh" for this app's own
    // seedQsoDefaults/updateDupeBanner, for the same reason.
    bus.addEventListener("prefill-log", (e) => prefillSpotLog(e.detail));
    bus.addEventListener("radio-profile-changed", () => seedQsoDefaults());
    bus.addEventListener("dupe-banner-refresh", () => updateDupeBanner());
    // js/apps/ft8/index.js dispatches these two — see applyFt8FreqBandMode /
    // applyFt8LogExchange's own header note (split from one "ft8-log" event
    // per PR #41).
    bus.addEventListener("ft8-log-defaults", (e) => applyFt8FreqBandMode(e.detail));
    bus.addEventListener("ft8-log-exchange", (e) => applyFt8LogExchange(e.detail));

    // ctx.logger: js/apps/ft8/index.js's captureFt8QsoSnapshot/
    // syncFt8ToLog (FT8,) need buildQsoFromForm()/
    // seedDateTime() synchronously — see this file's header note.
    ctx.logger = {
      buildQsoFromForm,
      seedDateTime,
    };

    populateContestSelect();
    applyLogbookUi();
    seedQsoDefaults();
    renderQsos();
  }
};
