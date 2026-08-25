// Shell — the chrome shared by every mini-app: the dual-pane tab manager, the
// theme cluster, collapsible-card persistence, service-worker registration, the
// sidebar VFO header, and the global audio device selectors.
//
// Everything here lives OUTSIDE any tab panel. If an element belongs to one tab,
// it belongs to that tab's mini-app, not this file.
//
// Constraints worth knowing before changing anything here:
//
// - mountShell() is synchronous, and js/main.js depends on that: the mount loop
//   runs after it returns, so every app can assume the page exists. The one
//   asynchronous piece (audio device enumeration) is detached at the end.
//
// - The shell mounts BEFORE any app, so the capabilities apps publish on ctx
//   (ctx.ft8, ctx.audioMonitor) are undefined during its own boot-time calls.
//   Every reach into a mini-app is optional-chained for that reason.
//
// - Panels are MOVED between panes and the pool, never recreated, so element
//   references captured by a mini-app at mount stay valid. Mobile is a pure
//   presentation layer over the same pane state: `panes` is never mutated for it.
//
// - VIEW_ORDER is hardcoded and console.assert'd against the mounted apps, so an
//   app that forgets its entry fails loudly instead of silently never getting a
//   tab.
//
// - The sidebar VFO header listens for cat "status", not just
//   "frequency"/"mode": the live polling parsers only ever dispatch "status", so
//   listening for the other two alone freezes the readout between staged tunes.
//
// - activateTab() toggles a CSS-dead "active" class ([data-tab] matches nothing
//   in the current DOM). It is kept because the "tab-activated" event it
//   dispatches is what tells a newly-visible app to measure itself — Leaflet
//   renders grey at the wrong size without it.
import { normalizeThemePreference, formatSidebarVfo, parseFrequencyText } from "../utils.js";
import { KEYS } from "../connectors/settings.js";
import { getSelectedModeLabel } from "../connectors/cat.js";
import { bus } from "../bus.js";
import { appendSerialLog } from "../serial-log.js";
import { mountNotice } from "./notice.js";
import { mountOnboarding, openGuide } from "./onboarding.js";

const THEME_CYCLE_ORDER = ["light", "dark", "system"];
const THEME_COLORS = {
  dark: "#14110c",
  light: "#dee6d0"
};
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

// Cards with a collapse toggle whose state persists. One list drives both the
// click bindings and the boot-time restore; each card's toggle button is its id
// with "-card" swapped for "-toggle" (#radio-connection-card /
// #radio-connection-toggle), which is the convention index.html already follows.
const COLLAPSIBLE_CARDS = [
  "radio-connection-card",
  "cw-macro-card",
  "voice-keyer-card",
  "image-editor-card",
  "search-callsign-card",
];

const state = {
  activeTab: "radio",
};

function mountPaneTabManager(apps) {
        var VIEWS = {
          radio:          'Radio Dashboard',
          ft8:            'FT8',
          logger:         'Logbook',
          spots:          'Clusters',
          map:            'Map',
          satellites:     'Satellites',
          sstv:           'SSTV',
          'audio-macros': 'Audio & Macros',
          settings:       'Settings'
        };
        var VIEW_ORDER = ['radio', 'ft8', 'logger', 'spots', 'map', 'satellites', 'sstv', 'audio-macros', 'settings'];

        console.assert(apps.every(function (a) { return VIEW_ORDER.indexOf(a.id) !== -1; }), "app missing from shell VIEW_ORDER");

        var ICON_PATHS = {
          radio:      '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>',
          ft8:        '<path d="M3 14h2l2-8 4 16 2-8h2l2-4h6"/>',
          logger:     '<path d="M5 4h9l3 3v13a2 2 0 0 1-2 2H5z"/><path d="M5 9h12M5 13h8"/>',
          spots:      '<circle cx="6" cy="14" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="17" cy="15" r="1.3"/><circle cx="13" cy="18" r="1.3"/><path d="M6 14l5-6 6 7-4 3z"/>',
          map:        '<path d="M4 6l6-2 6 2 4-2v14l-4 2-6-2-6 2-4-2z"/><path d="M10 4v14M16 6v14"/>',
          satellites: '<path d="M12 4l1.5 3 3 1.5-3 1.5L12 13l-1.5-3-3-1.5 3-1.5z"/><path d="M5 17l3-4M16 11l3 6M9 11h6"/>',
          settings:        '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.6 4.6l2 2M17.4 17.4l2 2M2 12h3M19 12h3M4.6 19.4l2-2M17.4 6.6l2-2"/>',
          sstv:            '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M7 5v4"/><circle cx="15" cy="14" r="2.2"/>',
          'audio-macros': '<path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/>'
        };

        var PANES_KEY = 'web-ham-logger.panes';

        function savePanesState() {
          try {
            localStorage.setItem(PANES_KEY, JSON.stringify({
              a: { tabs: panes.a.tabs.slice(), active: panes.a.active },
              b: { tabs: panes.b.tabs.slice(), active: panes.b.active },
              /* Persisted so a reload on a phone keeps you on the view you were
                 actually looking at, rather than snapping back to pane A's. */
              mobile: mobileActive
            }));
          } catch (e) {}
        }

        function loadPanesState() {
          try {
            var saved = JSON.parse(localStorage.getItem(PANES_KEY));
            if (!saved) return null;
            var allViews = Object.keys(VIEWS);
            var seen = {};
            var aTabs = (saved.a && Array.isArray(saved.a.tabs) ? saved.a.tabs : [])
              .filter(function (v) { if (seen[v]) return false; seen[v] = true; return allViews.indexOf(v) !== -1; });
            var bTabs = (saved.b && Array.isArray(saved.b.tabs) ? saved.b.tabs : [])
              .filter(function (v) { if (seen[v]) return false; seen[v] = true; return allViews.indexOf(v) !== -1; });
            if (!aTabs.length && !bTabs.length) return null;
            var aActive = aTabs.indexOf(saved.a ? saved.a.active : null) !== -1 ? saved.a.active : (aTabs[0] || null);
            var bActive = bTabs.indexOf(saved.b ? saved.b.active : null) !== -1 ? saved.b.active : (bTabs[0] || null);
            var mobile = aTabs.concat(bTabs).indexOf(saved.mobile) !== -1 ? saved.mobile : null;
            return { a: { tabs: aTabs, active: aActive }, b: { tabs: bTabs, active: bActive }, mobile: mobile };
          } catch (e) {
            return null;
          }
        }

        /* panes.a / panes.b  –  tabs: ordered list of open view IDs,  active: currently shown */
        var loadedPanes = loadPanesState();
        var panes = loadedPanes || {
          a: { tabs: ['ft8'],    active: 'ft8'    },
          b: { tabs: ['logger'], active: 'logger' }
        };

        /* ---- Mobile: one unified tab bar, one visible view -------------------
           At <=640px the two-pane layout collapses to a single pane. Rather than
           forking the pane state, mobile is a pure PRESENTATION layer over it:
           `panes` is never mutated here, the chosen view's panel is simply moved
           into pane A's content div (panels are always MOVED, never recreated,
           so panel identity survives — the FT8 app caches element refs), and
           returning to desktop just restores each pane's own active panel.

           This replaces the earlier A/B pane switcher, which forced you to know
           which pane a view lived in. Here every open view is one tap away. */
        var mobileMedia = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
        function isMobile() { return mobileMedia ? mobileMedia.matches : false; }

        var mobileActive = (loadedPanes && loadedPanes.mobile) || null;

        function ownerPane(viewId) {
          if (panes.a.tabs.indexOf(viewId) !== -1) return 'a';
          if (panes.b.tabs.indexOf(viewId) !== -1) return 'b';
          return null;
        }

        /* Keep mobileActive pointing at something that is actually open. */
        function normalizeMobileActive() {
          var open = allOpen();
          if (open.length === 0) { mobileActive = null; return; }
          if (!mobileActive || open.indexOf(mobileActive) === -1) {
            mobileActive = panes.a.active || panes.b.active || open[0];
          }
        }

        function applyMobileView() {
          /* A maximize left over from desktop would hide the surviving pane via
             .wh-pane-area.wh-maximized, blanking the whole area on mobile. */
          if (maximized) toggleMaximize(maximized);
          normalizeMobileActive();
          if (mobileActive) showPanel('a', mobileActive);
          renderMobileTabs();
        }

        function restoreDesktopView() {
          /* Mobile parks the chosen view in pane A regardless of ownership. If
             pane A has no tabs of its own, that panel must go back to the pool or
             it sits in an empty pane with no tab bar entry. */
          ['a', 'b'].forEach(function (pane) {
            if (panes[pane].active) return;
            var stray = getContent(pane).querySelector('.pane-tab-active');
            if (stray) {
              stray.classList.remove('pane-tab-active');
              pool().appendChild(stray);
            }
          });
          if (panes.a.active) showPanel('a', panes.a.active);
          if (panes.b.active) showPanel('b', panes.b.active);
          renderMobileTabs();
        }

        function setMobileActive(viewId) {
          if (allOpen().indexOf(viewId) === -1) return;
          mobileActive = viewId;
          showPanel('a', viewId);
          renderMobileTabs();
        }

        /* Rebuild the mobile bar: one tab per open view (both panes), plus an
           add button. Reuses the desktop .wh-tab classes so it inherits styling. */
        function renderMobileTabs() {
          var bar = document.getElementById('wh-mobile-tabbar');
          if (!bar) return;
          /* Rebuilding destroys any open menu's DOM but not its keydown handler,
             which would then act on an invisible menu. */
          hideMenus();
          bar.innerHTML = '';
          if (!isMobile()) return;
          normalizeMobileActive();

          allOpen().forEach(function (viewId) {
            var name = VIEWS[viewId] || viewId;
            var isActive = viewId === mobileActive;
            var tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'wh-tab' + (isActive ? ' wh-tab-active' : '');
            tab.dataset.view = viewId;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');

            /* Wrapped, like the desktop tab, so the label is what truncates
               when the bar is crowded rather than the × being pushed out. */
            var label = document.createElement('span');
            label.className = 'wh-tab-label';
            label.textContent = name;
            tab.appendChild(label);

            tab.addEventListener('click', function (e) {
              if (e.target.classList.contains('wh-tab-close')) return;
              setMobileActive(viewId);
            });

            /* The × is rendered only on the tab already showing. On a phone
               these chips ARE the view switcher, and the whole chip is barely
               wider than a fingertip: a close target on every one of them
               meant reaching for a view and losing it instead. Switching now
               takes one tap and can't destroy anything; closing takes two, on
               a view you are looking at. Same reasoning as the desktop tab's
               Delete shortcut, which is kept here for keyboard users. */
            if (isActive) {
              var close = document.createElement('span');
              close.className = 'wh-tab-close';
              close.setAttribute('aria-hidden', 'true');
              close.textContent = '×';
              close.addEventListener('click', function (e) {
                e.stopPropagation();
                var owner = ownerPane(viewId);
                if (owner) closeTab(owner, viewId);
              });
              tab.appendChild(close);
              tab.setAttribute('aria-keyshortcuts', 'Delete');
              tab.title = name + ' — Delete key or × to close';
              tab.addEventListener('keydown', function (e) {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  var owner = ownerPane(viewId);
                  if (owner) closeTab(owner, viewId);
                }
              });
            } else {
              tab.title = 'Show ' + name;
            }

            bar.appendChild(tab);
          });

          /* Add button + its own menu host. The pane bars (and their menus) are
             hidden on mobile, so the menu has to live in this bar instead. */
          var wrap = document.createElement('div');
          wrap.className = 'wh-tab-add-wrap';

          var add = document.createElement('button');
          add.type = 'button';
          add.className = 'wh-tab-add-btn';
          add.id = 'wh-mobile-add';
          add.textContent = '+';
          add.setAttribute('aria-label', 'Open a view');
          var remaining = VIEW_ORDER.filter(function (v) { return allOpen().indexOf(v) === -1; });
          add.disabled = remaining.length === 0;
          add.addEventListener('click', function (e) {
            e.stopPropagation();
            /* Opens into pane A: on mobile "which pane" is not a user-visible
               concept, and pane A is the host for the single visible view. */
            showAddMenu('a', { btn: 'wh-mobile-add', menu: 'wh-mobile-menu' });
          });
          wrap.appendChild(add);

          var menuHost = document.createElement('div');
          menuHost.className = 'wh-tab-add-menu';
          menuHost.id = 'wh-mobile-menu';
          menuHost.setAttribute('hidden', '');
          wrap.appendChild(menuHost);

          bar.appendChild(wrap);
        }

        /* React to crossing the breakpoint. Nothing listened for this before, so
           rotating a phone or resizing a desktop window left the layout stale. */
        if (mobileMedia) {
          var onBreakpoint = function () {
            if (isMobile()) applyMobileView();
            else restoreDesktopView();
          };
          if (mobileMedia.addEventListener) mobileMedia.addEventListener('change', onBreakpoint);
          else if (mobileMedia.addListener) mobileMedia.addListener(onBreakpoint);
        }

        function pool()              { return document.getElementById('wh-panel-pool'); }
        function getPanel(id)        { return document.getElementById('tab-' + id); }
        function getContent(pane)    { return document.getElementById('pane-' + pane + '-content'); }

        function allOpen() {
          return panes.a.tabs.concat(panes.b.tabs);
        }

        /* Move a panel into a pane content div and mark it visible */
        function showPanel(pane, viewId) {
          var content = getContent(pane);
          /* Already hosted here? Re-appending would round-trip the node through
             the pool and reset every scroll position inside it — which mobile
             hits routinely, since applyMobileView re-shows the current view. */
          if (getPanel(viewId).parentNode === content) {
            getPanel(viewId).classList.add('pane-tab-active');
            bus.dispatchEvent(new CustomEvent('tab-activated', { detail: viewId }));
            return;
          }
          /* Deactivate + return current active panel to pool */
          var old = content.querySelector('.pane-tab-active');
          if (old) {
            old.classList.remove('pane-tab-active');
            pool().appendChild(old);
          }
          var panel = getPanel(viewId);
          content.appendChild(panel);
          panel.classList.add('pane-tab-active');
          /* Tell the newly-visible app it can measure itself. Leaflet needs this
             (invalidateSize) or the map renders grey at the wrong size. Only
             activateTab dispatched this before, so plain tab switches — and now
             every mobile switch — went unannounced. */
          bus.dispatchEvent(new CustomEvent('tab-activated', { detail: viewId }));
        }

        /* Open a new tab in pane; no-op if the view is already open anywhere */
        function openTab(pane, viewId) {
          if (allOpen().indexOf(viewId) !== -1) return;
          panes[pane].tabs.push(viewId);
          panes[pane].active = viewId;
          showPanel(pane, viewId);
          renderTabs('a');
          renderTabs('b');
          /* Explicitly opening a view should land you on it, so seed mobileActive
             rather than letting normalizeMobileActive keep the previous view. */
          if (isMobile()) { mobileActive = viewId; applyMobileView(); }
          savePanesState();
        }

        /* Switch the visible tab within a pane */
        function switchTab(pane, viewId) {
          if (panes[pane].active === viewId) return;
          if (panes[pane].tabs.indexOf(viewId) === -1) return;
          panes[pane].active = viewId;
          showPanel(pane, viewId);
          renderTabs(pane);
          savePanesState();
        }

        /* Close a tab; activates the nearest remaining tab */
        function closeTab(pane, viewId) {
          var tabs = panes[pane].tabs;
          var idx  = tabs.indexOf(viewId);
          if (idx === -1) return;
          tabs.splice(idx, 1);
          var panel = getPanel(viewId);
          panel.classList.remove('pane-tab-active');
          pool().appendChild(panel);
          if (panes[pane].active === viewId) {
            if (tabs.length > 0) {
              var next = tabs[Math.max(0, idx - 1)];
              panes[pane].active = next;
              showPanel(pane, next);
            } else {
              panes[pane].active = null;
            }
          }
          renderTabs('a');
          renderTabs('b');
          if (isMobile()) applyMobileView();
          savePanesState();
        }

        /* Swap all tabs between panes */
        function swapPanes() {
          var aSnap = { tabs: panes.a.tabs.slice(), active: panes.a.active };
          var bSnap = { tabs: panes.b.tabs.slice(), active: panes.b.active };
          /* Return all panels to pool */
          aSnap.tabs.concat(bSnap.tabs).forEach(function (v) {
            var p = getPanel(v);
            p.classList.remove('pane-tab-active');
            pool().appendChild(p);
          });
          panes.a = { tabs: bSnap.tabs.slice(), active: bSnap.active };
          panes.b = { tabs: aSnap.tabs.slice(), active: aSnap.active };
          if (panes.a.active) showPanel('a', panes.a.active);
          if (panes.b.active) showPanel('b', panes.b.active);
          renderTabs('a');
          renderTabs('b');
          if (isMobile()) applyMobileView();
          savePanesState();
        }

        /* ---- Drag-and-drop: reorder tabs within a pane, or move a tab to the
           other pane. Pure HTML5 DnD, no deps (ported from the monolith,
           feature #8). Two fixes over that original: the bar-level listeners are
           wired ONCE in the init loop below (the monolith re-added them on every
           renderTabs, stacking duplicates), and a cross-pane move reassigns the
           source pane's active tab when the moved tab was the active one (the
           monolith left a dangling active pointer). */
        var dragState = { srcPane: null, viewId: null };

        function clearDropIndicators() {
          document.querySelectorAll('.wh-tab-drop-indicator').forEach(function (el) { el.remove(); });
        }

        /* Index in `bar` where a drop at clientX should insert. */
        function dropInsertIndex(bar, clientX) {
          var tabs = Array.from(bar.querySelectorAll('.wh-tab'));
          for (var i = 0; i < tabs.length; i++) {
            var r = tabs[i].getBoundingClientRect();
            if (clientX < r.left + r.width / 2) return i;
          }
          return tabs.length;
        }

        function showDropIndicator(bar, idx) {
          clearDropIndicators();
          var indicator = document.createElement('div');
          indicator.className = 'wh-tab-drop-indicator';
          var tabs = bar.querySelectorAll('.wh-tab');
          if (idx < tabs.length) tabs[idx].parentNode.insertBefore(indicator, tabs[idx]);
          else bar.appendChild(indicator);
        }

        function paneOfBar(bar) { return bar.id.replace('pane-', '').replace('-tabs', ''); }

        function handleTabBarDragOver(e) {
          if (!dragState.viewId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          showDropIndicator(e.currentTarget, dropInsertIndex(e.currentTarget, e.clientX));
        }

        function handleTabBarDrop(e) {
          if (!dragState.viewId) return;
          e.preventDefault();
          e.stopPropagation();
          var bar = e.currentTarget;
          var targetPane = paneOfBar(bar);
          var srcPane = dragState.srcPane;
          var viewId = dragState.viewId;
          clearDropIndicators();
          if (!srcPane || !viewId) return;
          var srcIdx = panes[srcPane].tabs.indexOf(viewId);
          if (srcIdx === -1) return;
          var insertIdx = dropInsertIndex(bar, e.clientX);
          panes[srcPane].tabs.splice(srcIdx, 1);
          if (targetPane !== srcPane) {
            panes[targetPane].tabs.splice(insertIdx, 0, viewId);
            panes[targetPane].active = viewId;
            showPanel(targetPane, viewId);
            /* Moved out of the source pane — reactivate its nearest remaining
               tab (mirrors closeTab), rather than leaving a dangling pointer. */
            if (panes[srcPane].active === viewId) {
              var rem = panes[srcPane].tabs;
              if (rem.length > 0) {
                var next = rem[Math.max(0, srcIdx - 1)];
                panes[srcPane].active = next;
                showPanel(srcPane, next);
              } else {
                panes[srcPane].active = null;
              }
            }
          } else {
            panes[srcPane].tabs.splice(insertIdx > srcIdx ? insertIdx - 1 : insertIdx, 0, viewId);
          }
          renderTabs('a');
          renderTabs('b');
          savePanesState();
        }

        /* Rebuild the tab bar for one pane */
        function renderTabs(pane) {
          var bar    = document.getElementById('pane-' + pane + '-tabs');
          var addBtn = document.getElementById('pane-' + pane + '-add');
          bar.innerHTML = '';
          panes[pane].tabs.forEach(function (viewId) {
            var tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'wh-tab' + (viewId === panes[pane].active ? ' wh-tab-active' : '');
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', viewId === panes[pane].active ? 'true' : 'false');
            tab.dataset.view = viewId;
            tab.draggable = true;
            tab.dataset.pane = pane;

            var label = document.createElement('span');
            label.className = 'wh-tab-label';
            label.textContent = VIEWS[viewId];
            tab.appendChild(label);

            /* The close affordance is a span, not a button, because it lives
               INSIDE the tab's own <button role="tab"> and nesting interactive
               content inside a button is invalid HTML. That left it reachable
               by pointer only: a keyboard or screen-reader user had no way to
               close a tab at all.
               The fix follows the ARIA authoring practice for deletable tabs —
               the tab itself handles Delete/Backspace, and aria-keyshortcuts
               advertises it so assistive tech can announce it. The span is
               marked aria-hidden because it is now purely the visual handle for
               an action the tab exposes; leaving an aria-label on an element
               that can never be focused only promised something unreachable. */
            var closeBtn = document.createElement('span');
            closeBtn.className = 'wh-tab-close';
            closeBtn.setAttribute('aria-hidden', 'true');
            closeBtn.textContent = '×';
            tab.appendChild(closeBtn);

            tab.setAttribute('aria-keyshortcuts', 'Delete');
            tab.title = VIEWS[viewId] + ' — Delete key or × to close';

            tab.addEventListener('click', function (e) {
              if (e.target === closeBtn || e.target.classList.contains('wh-tab-close')) {
                e.stopPropagation();
                closeTab(pane, viewId);
              } else {
                switchTab(pane, viewId);
              }
            });
            tab.addEventListener('dragstart', function (e) {
              dragState.srcPane = pane;
              dragState.viewId = viewId;
              e.dataTransfer.effectAllowed = 'move';
              tab.classList.add('wh-tab-dragging');
            });
            tab.addEventListener('dragend', function () {
              tab.classList.remove('wh-tab-dragging');
              clearDropIndicators();
              dragState = { srcPane: null, viewId: null };
            });
            tab.addEventListener('keydown', function (e) {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                closeTab(pane, viewId);
              }
            });
            bar.appendChild(tab);
          });

          /* Disable add button if no views remain */
          var available = VIEW_ORDER.filter(function (v) { return allOpen().indexOf(v) === -1; });
          addBtn.disabled = available.length === 0;
        }

        /* Populate and show the add-tab dropdown for a pane (dense variant — no hints, no footer) */
        var menuKeyHandler = null;

        /* `ids` lets a caller host the menu outside the pane bar — the mobile tab
           bar needs that, since it hides the pane bars (and a menu inside a
           display:none subtree can never be seen). The menu is position:fixed and
           placed from the button's rect, so its DOM parent doesn't affect layout. */
        function showAddMenu(pane, ids) {
          var btn       = document.getElementById((ids && ids.btn)  || ('pane-' + pane + '-add'));
          var menu      = document.getElementById((ids && ids.menu) || ('pane-' + pane + '-menu'));
          if (!btn || !menu) return;
          var available = VIEW_ORDER.filter(function (v) { return allOpen().indexOf(v) === -1; });
          if (available.length === 0) return;

          menu.innerHTML = '';
          var focusIdx = 0;

          /* Drop-shadow ghost */
          var shadow = document.createElement('div');
          shadow.className = 'wh-menu-shadow';
          menu.appendChild(shadow);

          /* Card */
          var card = document.createElement('div');
          card.className = 'wh-menu-card';

          /* Header */
          var header = document.createElement('div');
          header.className = 'wh-menu-header';
          header.innerHTML = '<span class="wh-menu-header-title">Open view</span>';
          card.appendChild(header);

          /* Items */
          var itemsWrap = document.createElement('div');
          itemsWrap.className = 'wh-menu-items';
          var itemEls = [];

          available.forEach(function (viewId) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'wh-menu-item';
            item.innerHTML =
              '<svg class="wh-menu-dot" width="18" height="18" viewBox="0 0 18 18">' +
                '<circle cx="9" cy="9" r="4.2" filter="url(#rough)"/>' +
              '</svg>' +
              '<span class="wh-menu-item-label">' + VIEWS[viewId] + '</span>' +
              '<div class="wh-menu-item-right">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
                  ICON_PATHS[viewId] +
                '</svg>' +
                '<svg class="wh-menu-triangle" width="14" height="16" viewBox="0 0 14 16" style="overflow:visible">' +
                  '<path d="M2,2 L12,8 L2,14 z" filter="url(#rough)"/>' +
                '</svg>' +
              '</div>';

            item.addEventListener('click', function () {
              openTab(pane, viewId);
              hideMenus();
            });
            item.addEventListener('mouseenter', function () {
              setFocus(itemEls.indexOf(item));
            });
            itemsWrap.appendChild(item);
            itemEls.push(item);
          });
          card.appendChild(itemsWrap);
          menu.appendChild(card);

          /* Position using fixed coords so parent overflow:hidden never clips it */
          var rect = btn.getBoundingClientRect();
          var menuWidth = 260;
          var left = rect.left;
          if (left + menuWidth > window.innerWidth - 8) {
            left = rect.right - menuWidth;
          }
          menu.style.top  = (rect.bottom + 5) + 'px';
          menu.style.left = Math.max(8, left) + 'px';
          menu.removeAttribute('hidden');

          /* Keyboard focus */
          function setFocus(idx) {
            itemEls.forEach(function (el) { el.classList.remove('wh-menu-item-focused'); });
            if (idx >= 0 && idx < itemEls.length) {
              focusIdx = idx;
              itemEls[idx].classList.add('wh-menu-item-focused');
            }
          }
          setFocus(0);

          if (menuKeyHandler) document.removeEventListener('keydown', menuKeyHandler);
          menuKeyHandler = function (e) {
            if (menu.hasAttribute('hidden')) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault(); setFocus((focusIdx + 1) % itemEls.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault(); setFocus((focusIdx - 1 + itemEls.length) % itemEls.length);
            } else if (e.key === 'Enter') {
              e.preventDefault(); openTab(pane, available[focusIdx]); hideMenus();
            } else if (e.key === 'Escape') {
              hideMenus();
            }
          };
          document.addEventListener('keydown', menuKeyHandler);
        }

        function hideMenus() {
          document.querySelectorAll('.wh-tab-add-menu').forEach(function (m) {
            m.setAttribute('hidden', '');
          });
          if (menuKeyHandler) {
            document.removeEventListener('keydown', menuKeyHandler);
            menuKeyHandler = null;
          }
        }

        /* ---- Wire up ---- */
        ['a', 'b'].forEach(function (pane) {
          document.getElementById('pane-' + pane + '-add').addEventListener('click', function (e) {
            e.stopPropagation();
            var menu = document.getElementById('pane-' + pane + '-menu');
            if (menu.hasAttribute('hidden')) {
              hideMenus();
              showAddMenu(pane);
            } else {
              hideMenus();
            }
          });
          /* Bar-level DnD wired ONCE per pane — the #pane-*-tabs element persists
             across renderTabs, so repeated renders never stack duplicate
             listeners (the monolith's bug). */
          var bar = document.getElementById('pane-' + pane + '-tabs');
          bar.addEventListener('dragover', handleTabBarDragOver);
          bar.addEventListener('drop', handleTabBarDrop);
          bar.addEventListener('dragleave', clearDropIndicators);
        });

        document.addEventListener('click', hideMenus);

        document.getElementById('wh-swap-btn').addEventListener('click', swapPanes);

        /* ---- Maximize / restore ---- */
        var maximized = null;

        function toggleMaximize(pane) {
          var paneArea = document.querySelector('.wh-pane-area');
          var paneEl   = document.getElementById('pane-' + pane);
          var otherEl  = document.getElementById(pane === 'a' ? 'pane-b' : 'pane-a');
          var btn      = paneEl.querySelector('.wh-pane-maximize');

          if (maximized === pane) {
            paneArea.classList.remove('wh-maximized');
            paneEl.classList.remove('wh-pane-maximized');
            btn.setAttribute('aria-label', 'Maximize pane ' + pane.toUpperCase());
            btn.title = 'Maximize';
            maximized = null;
          } else {
            if (maximized) {
              var prevEl  = document.getElementById('pane-' + maximized);
              var prevBtn = prevEl.querySelector('.wh-pane-maximize');
              prevEl.classList.remove('wh-pane-maximized');
              prevBtn.setAttribute('aria-label', 'Maximize pane ' + maximized.toUpperCase());
              prevBtn.title = 'Maximize';
            }
            paneArea.classList.add('wh-maximized');
            paneEl.classList.add('wh-pane-maximized');
            btn.setAttribute('aria-label', 'Restore pane ' + pane.toUpperCase());
            btn.title = 'Restore';
            maximized = pane;
          }
        }

        ['a', 'b'].forEach(function (pane) {
          document.querySelector('#pane-' + pane + ' .wh-pane-maximize')
            .addEventListener('click', function () { toggleMaximize(pane); });
        });

        /* Bring a view forward so it's actually visible: switch to it if it's
           already open in a pane, otherwise open it (defaulting to pane B,
           the logger's home, unless A is the empty one); and un-maximize the
           OTHER pane if it's covering the target. This is the reachability seam
           the shell exposes to the rest of the app (see the "activate-tab" bus
           listener) — e.g. the header "+ New QSO" must reveal the Logbook even
           when its tab was closed or the other pane is maximized. */
        function revealView(viewId) {
          if (!VIEWS[viewId]) return null;
          var pane = panes.a.tabs.indexOf(viewId) !== -1 ? 'a'
                   : panes.b.tabs.indexOf(viewId) !== -1 ? 'b' : null;
          if (!pane) {
            pane = (panes.a.tabs.length === 0 && panes.b.tabs.length > 0) ? 'a' : 'b';
            openTab(pane, viewId);
          } else {
            switchTab(pane, viewId);
          }
          if (maximized && maximized !== pane) toggleMaximize(maximized);
          /* On mobile the panes collapse to one, so "reveal" means: make this
             the single visible view. */
          if (isMobile()) setMobileActive(viewId);
          return pane;
        }

        /* ---- Initialise ---- */
        if (panes.a.active) showPanel('a', panes.a.active);
        if (panes.b.active) showPanel('b', panes.b.active);
        renderTabs('a');
        renderTabs('b');
        if (isMobile()) applyMobileView(); else renderMobileTabs();
        savePanesState();
        window.addEventListener('beforeunload', savePanesState);

        return { revealView: revealView };
}

// Deliberately synchronous. It used to be `async`, with main.js calling it
// WITHOUT `await` and relying on the mount loop running during the gap created
// by this function's first `await` — which only worked because that await
// happened to be the last statement. Any future `await` added earlier would have
// silently moved the app mount loop ahead of the DOM this builds, and a rejection
// anywhere in here became an unhandled promise rejection rather than an error.
//
// The one genuinely async piece (audio device enumeration) is now an explicit
// fire-and-forget at the end, so the ordering contract is "this function returns
// when the shell is built", which is what every caller actually needs.
export function mountShell(apps, ctx) {
  const { cat, audio, settings } = ctx;

  // per-app/global audio device config into the connector before anything
  // (including this module's own applyAudioDeviceConfig() at the end) reads it.
  audio.loadDeviceConfig();

  // Experimental/AI-generated disclosure strip, and the donate link with it.
  // Runs first so it is in place before the pane layout measures itself against
  // the viewport — revealing it afterwards would shorten the panes by its
  // height after they had already sized themselves.
  mountNotice();

  const paneManager = mountPaneTabManager(apps);

  const els = {
    tabPanels: [...document.querySelectorAll("[data-tab-panel]")],
    tabButtons: [...document.querySelectorAll("[data-tab]")],
    sidebarThemeToggle: document.querySelector("#sidebar-theme-toggle"),
    settingsThemeOptions: [...document.querySelectorAll("#settings-theme-picker .settings-theme-option")],
    settingsSaveStatus: document.querySelector("#settings-save-status"),
    // Collapsible-card toggles/cards are resolved from COLLAPSIBLE_CARDS below.
    sidebarVfoFreq: document.querySelector("#sidebar-vfo-freq"),
    sidebarVfoMode: document.querySelector("#sidebar-vfo-mode"),
    sidebarSmeterFill: document.querySelector("#sidebar-smeter-fill"),
    sidebarSmeterText: document.querySelector("#sidebar-smeter-text"),
    sidebarFootStatus: document.querySelector("#sidebar-foot-status"),
    // global audio device selectors live in the top strip (shell
    // chrome, outside every tab panel) — see applyAudioDeviceConfig() below.
    globalAudioInput: document.querySelector("#global-audio-input"),
    globalAudioOutput: document.querySelector("#global-audio-output"),
    // Cross-tab: Audio & Macros tab (Voice Keyer card). Dual-queried here
    // (same pattern audio-macros/index.js uses for its own copy) because
    // applyAudioDeviceConfig's global-mode sync writes it directly.
    voiceOutputDevice: document.querySelector("#voice-output-device"),
    // Cross-tab: Settings tab.
    settingsPerAppAudio: document.querySelector("#settings-per-app-audio"),
    settingsAudioRoutingNote: document.querySelector("#settings-audio-routing-note-text"),
  };

  function activateTab(tabId) {
    state.activeTab = tabId;
    els.tabPanels.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tabPanel === tabId);
    });
    els.tabButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tabId);
    });
    // the `tabId === "map"` invalidateSize()/renderMap() branch that
    // used to run here moved to js/apps/map/index.js (both state.mapInstance
    // and renderMap() are map-app-owned now) — it listens for this dispatch
    // and re-checks tabId === "map" itself.
    bus.dispatchEvent(new CustomEvent("tab-activated", { detail: tabId }));
  }

  function resolveTheme(themePreference) {
    const normalizedTheme = normalizeThemePreference(themePreference);
    return normalizedTheme === "system"
      ? (systemThemeQuery.matches ? "dark" : "light")
      : normalizedTheme;
  }

  function syncThemeControls(themePreference) {
    const normalizedTheme = normalizeThemePreference(themePreference);
    els.settingsThemeOptions.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeOption === normalizedTheme);
    });
    if (els.sidebarThemeToggle) {
      const nextTheme = THEME_CYCLE_ORDER[(THEME_CYCLE_ORDER.indexOf(normalizedTheme) + 1) % THEME_CYCLE_ORDER.length];
      els.sidebarThemeToggle.dataset.themePreference = normalizedTheme;
      els.sidebarThemeToggle.setAttribute("aria-label", `Theme: ${normalizedTheme}. Click to switch to ${nextTheme} theme.`);
      els.sidebarThemeToggle.title = `Theme: ${normalizedTheme}`;
    }
  }

  function setThemePreference(themePreference, options = {}) {
    const { persist = false, showSavedStatus = false } = options;
    const normalizedTheme = normalizeThemePreference(themePreference);
    syncThemeControls(normalizedTheme);
    applyTheme(normalizedTheme);
    if (persist) {
      const updatedSettings = { ...settings.get(), theme: normalizedTheme };
      settings.set(updatedSettings);
      if (showSavedStatus && els.settingsSaveStatus) {
        els.settingsSaveStatus.textContent = "✓ Theme saved.";
        setTimeout(() => {
          if (els.settingsSaveStatus.textContent === "✓ Theme saved.") {
            els.settingsSaveStatus.textContent = "";
          }
        }, 2500);
      }
    }
  }

  function applyTheme(themePreference) {
    const normalizedTheme = normalizeThemePreference(themePreference);
    const resolvedTheme = resolveTheme(normalizedTheme);
    document.documentElement.dataset.themePreference = normalizedTheme;
    document.documentElement.dataset.theme = resolvedTheme;
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", THEME_COLORS[resolvedTheme]);
    }
  }

  function handleSystemThemeChange() {
    const activeTheme = normalizeThemePreference(
      document.documentElement.dataset.themePreference || settings.get().theme
    );
    if (activeTheme === "system") {
      applyTheme(activeTheme);
    }
  }

  function cycleThemePreference() {
    const currentTheme = normalizeThemePreference(
      document.documentElement.dataset.themePreference || settings.get().theme
    );
    const currentIndex = THEME_CYCLE_ORDER.indexOf(currentTheme);
    const nextTheme = THEME_CYCLE_ORDER[(currentIndex + 1) % THEME_CYCLE_ORDER.length];
    setThemePreference(nextTheme, { persist: true, showSavedStatus: true });
  }

  function savePanelCollapseState(id, collapsed) {
    const saved = JSON.parse(localStorage.getItem(KEYS.PANEL_COLLAPSE_KEY) || "{}");
    saved[id] = collapsed;
    localStorage.setItem(KEYS.PANEL_COLLAPSE_KEY, JSON.stringify(saved));
  }

  function restorePanelCollapseStates() {
    const saved = JSON.parse(localStorage.getItem(KEYS.PANEL_COLLAPSE_KEY) || "{}");
    for (const id of COLLAPSIBLE_CARDS) {
      if (id in saved) {
        document.getElementById(id)?.classList.toggle("collapsed", saved[id]);
      }
    }
  }


  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    try {
      await navigator.serviceWorker.register("./sw.js");
      appendSerialLog("Offline support enabled.");
    } catch (error) {
      appendSerialLog(`Offline support unavailable: ${error.message}`);
    }
  }

  // (global audio selects live here in the top strip; the per-app selects
  // live on the FT8/audio-macros tabs), so it moved here rather than into
  // any one tab's mini-app, same reasoning as the theme cluster above.
  // Cross-panel writes reach those two apps through the capabilities they
  // publish on ctx (ctx.ft8.applyTxOutputDevice / ctx.audioMonitor.sync); they
  // were window globals until the connector-contract review.
  function applyAudioDeviceConfig() {
    const cfg = audio.getConfig();

    // Toggle body class for CSS visibility helpers
    if (cfg.perAppMode) {
      document.body.classList.add("wh-per-app-audio");
    } else {
      document.body.classList.remove("wh-per-app-audio");
    }

    // Sync global selects to saved values
    if (els.globalAudioInput && els.globalAudioInput.options.length > 1) {
      els.globalAudioInput.value = cfg.globalInput;
    }
    if (els.globalAudioOutput && els.globalAudioOutput.options.length > 1) {
      els.globalAudioOutput.value = cfg.globalOutput;
    }

    // In global mode, sync voice keyer output to globalOutput.
    if (!cfg.perAppMode && els.voiceOutputDevice) {
      const target = cfg.globalOutput;
      if ([...els.voiceOutputDevice.options].some(o => o.value === target)) {
        els.voiceOutputDevice.value = target;
      }
    }

    // Two cross-panel reaches into mini-apps, both through the ctx capabilities
    // those apps publish (see the contract note in js/main.js). Optional-chained
    // because the shell mounts BEFORE any app, so on the very first call — the
    // detached device-enumeration below — neither may exist yet; the "change"
    // handlers that call this later always find them.
    ctx.ft8?.applyTxOutputDevice?.();
    // Audio Monitor start/stop/state lives in the audio-macros mini-app —
    // audio-monitor-* elements are all in that tab panel.
    ctx.audioMonitor?.sync?.(cfg);
  }

  // Sidebar VFO header — split out of js/apps/radio/index.js's
  // updateFrequencyDisplay/syncRadioConsole/updateMissionDashboard (see this
  // file's header note for the wiring decision).
  function updateSidebarVfoFreq(frequencyHz) {
    if (!els.sidebarVfoFreq) return;
    els.sidebarVfoFreq.textContent = (Number.isFinite(frequencyHz) && frequencyHz > 0)
      ? formatSidebarVfo(frequencyHz)
      : "—.———.——";
  }

  function updateSidebarVfoMode() {
    if (!els.sidebarVfoMode) return;
    const m = cat.getMode() || getSelectedModeLabel() || "—";
    els.sidebarVfoMode.textContent = m.length > 10 ? `${m.slice(0, 9)}…` : m;
  }

  function updateSidebarSmeter() {
    const connected = cat.isConnected();
    if (els.sidebarSmeterFill) {
      els.sidebarSmeterFill.style.width = connected ? "72%" : "18%";
    }
    if (els.sidebarSmeterText) {
      els.sidebarSmeterText.textContent = connected ? "S9" : "S0";
    }
    if (els.sidebarFootStatus) {
      els.sidebarFootStatus.textContent = connected ? "CAT online" : "Ready";
    }
  }

  function syncSidebarVfoHeader() {
    updateSidebarVfoFreq(cat.getStagedFrequency() || parseFrequencyText(cat.getFrequency()));
    updateSidebarVfoMode();
    updateSidebarSmeter();
  }

  const safeBind = (el, event, handler) => {
    if (el) el.addEventListener(event, handler);
  };

  els.tabButtons.forEach((button) =>
    safeBind(button, "click", () => activateTab(button.dataset.tab))
  );
  // The collapsible cards, from the one list COLLAPSIBLE_CARDS above — five
  // copies of the same three lines before, which is also how the toggle id and
  // the card id could drift apart without anything noticing.
  for (const id of COLLAPSIBLE_CARDS) {
    const card = document.getElementById(id);
    safeBind(document.getElementById(`${id.replace(/-card$/, "")}-toggle`), "click", () => {
      card?.classList.toggle("collapsed");
      savePanelCollapseState(id, card?.classList.contains("collapsed") ?? false);
    });
  }
  safeBind(els.sidebarThemeToggle, "click", cycleThemePreference);
  systemThemeQuery.addEventListener("change", handleSystemThemeChange);
  els.settingsThemeOptions.forEach((btn) =>
    safeBind(btn, "click", () => setThemePreference(btn.dataset.themeOption))
  );

  // settingsPerAppAudio change bindings (see applyAudioDeviceConfig() above).
  safeBind(els.globalAudioInput, "change", () => {
    audio.getConfig().globalInput = els.globalAudioInput.value;
    audio.saveDeviceConfig();
    applyAudioDeviceConfig();
  });
  safeBind(els.globalAudioOutput, "change", () => {
    audio.getConfig().globalOutput = els.globalAudioOutput.value;
    audio.saveDeviceConfig();
    applyAudioDeviceConfig();
  });
  safeBind(els.settingsPerAppAudio, "change", () => {
    audio.getConfig().perAppMode = els.settingsPerAppAudio.checked;
    audio.saveDeviceConfig();
    applyAudioDeviceConfig();
    void audio.populateAllDevices().then(applyAudioDeviceConfig);
    if (els.settingsAudioRoutingNote) {
      els.settingsAudioRoutingNote.textContent = els.settingsPerAppAudio.checked
        ? "Each app now shows its own audio selectors."
        : "Set your shared devices in the top bar.";
    }
  });

  // js/apps/logger/index.js's own focusLogbookEntry
  // dispatches this (it can no longer call this module's same-module
  // activateTab directly) — see that file's header note.
  // Reveal the requested view in its pane (open/switch/un-maximize) BEFORE the
  // legacy activateTab dispatch — otherwise "+ New QSO" and friends no-op when
  // the target tab is closed or the other pane is maximized.
  bus.addEventListener("activate-tab", (e) => {
    paneManager?.revealView?.(e.detail);
    activateTab(e.detail);
  });

  // See this file's header note on the settings "change" listener split.
  // Guard on the key's presence: a partial settings "change" that omits `theme`
  // must not coerce the live theme to "system" (normalizeThemePreference's
  // default for undefined). Current callers always include theme; this keeps a
  // future partial update from silently flipping the theme.
  settings.addEventListener("change", (e) => {
    if (e.detail && "theme" in e.detail) setThemePreference(e.detail.theme, { persist: false });
  });

  cat.addEventListener("frequency", (e) => updateSidebarVfoFreq(e.detail));
  cat.addEventListener("mode", () => updateSidebarVfoMode());
  // Review fix (post-Task-19 regression): the connector's live-polling
  // parsers (parseFt897IncomingData/parseCivIncomingData/
  // parseAsciiIncomingData in js/connectors/cat.js) update lastFrequency/
  // lastMode internally but only ever dispatch "status" — never
  // "frequency"/"mode" (those two fire solely on staged-tune actions: spot
  // click, satellite Doppler, explicit setMode). Pre-move, radio's own
  // "status" handler called syncRadioConsole() -> updateFrequencyDisplay(),
  // which wrote both the tab-local readout and the sidebar fields, so every
  // live poll refreshed the sidebar. Calling only updateSidebarSmeter() here
  // dropped that: the sidebar froze at its boot value between staged tunes
  // with a real radio connected. Fix: run the full syncSidebarVfoHeader()
  // (freq+mode+smeter) on "status" too, so it re-derives displayHz the same
  // way syncRadioConsole() does. The "frequency"/"mode" listeners above stay
  // for the staged-tune path (immediate paint without waiting on the next
  // poll's "status"); both paths write the same values so there's no
  // flicker, just a possible harmless extra write of an identical string.
  cat.addEventListener("status", () => syncSidebarVfoHeader());

  activateTab(state.activeTab);
  void registerServiceWorker();
  restorePanelCollapseStates();
  syncSidebarVfoHeader();

  // Last, and after the layout exists: opening the guide makes every sibling of
  // it inside .wh-app inert, so it has to run once there is something to make
  // inert. It also collects the station callsign and grid, which it announces on
  // the bus for js/apps/settings/index.js to pick up.
  mountOnboarding();
  document.querySelector("#wh-notice-guide")?.addEventListener("click", openGuide);

  // Audio device enumeration — the only asynchronous work in the shell, and
  // nothing above or below depends on its result, so it runs detached. Errors
  // are caught here rather than surfacing as an unhandled rejection: a machine
  // with no audio devices, or a denied permission prompt, must not take the rest
  // of the shell down with it.
  void audio.populateAllDevices()
    .then(applyAudioDeviceConfig)
    .catch((error) => console.warn("[WebHam] audio device enumeration failed", error));
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    void audio.populateAllDevices().then(applyAudioDeviceConfig).catch(() => {});
  });
}
