#!/usr/bin/env bash
# check.sh — fast verification of WebHam changes
#
# Usage:
#   ./check.sh              # instant static checks (HTML + JS syntax)
#   ./check.sh --shot       # static checks + screenshot (auto-starts server)
#   ./check.sh --shot=logger # screenshot a specific tab
#
# Exit code: 0 = all checks passed, 1 = one or more failed

set -euo pipefail

# ── kill any stale server on our port so start-server.sh never gets EADDRINUSE
PORT=4173
_free_port() {
  local pid
  pid=$(fuser "${PORT}/tcp" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo -e "  \033[0;33m·\033[0m Freeing port ${PORT} (pid ${pid})…"
    fuser -k "${PORT}/tcp" 2>/dev/null || kill "$pid" 2>/dev/null || true
    sleep 0.3
  fi
}

# Register a cleanup so we kill any server WE started on exit
_OUR_SERVER_PID=""
_cleanup() {
  if [ -n "$_OUR_SERVER_PID" ]; then
    kill "$_OUR_SERVER_PID" 2>/dev/null || true
  fi
}
trap _cleanup EXIT

# ── colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILURES=$((FAILURES+1)); }
info() { echo -e "  ${YELLOW}·${NC} $1"; }

FAILURES=0
SCREENSHOT=0
TAB="ft8"

for arg in "$@"; do
  case "$arg" in
    --shot)    SCREENSHOT=1 ;;
    --shot=*)  SCREENSHOT=1; TAB="${arg#--shot=}" ;;
    --*)       ;;               # ignore unknown flags
    *)         TAB="$arg" ;;
  esac
done

# ── 1. JS syntax ─────────────────────────────────────────────────────────────
echo -e "\n${BOLD}JS syntax${NC}"
for f in server.js $(find js -name '*.js' 2>/dev/null | sort); do
  if node --check "$f" 2>/tmp/check-node-err; then
    ok "$f"
  else
    fail "$f — $(cat /tmp/check-node-err)"
  fi
done

# ── 1b. Service-worker precache covers the whole module graph ────────────────
# sw.js has to list every ES module reachable from js/main.js or an offline load
# fetches a miss, gets Response.error(), and the module graph never resolves. That
# had already drifted by three files — including secure-store.js, which main.js
# top-level awaits, so offline the app did not boot at all. A comment saying "keep
# in sync" was not enough; this is the check.
echo -e "\n${BOLD}Service-worker precache${NC}"
SW_MISSING=""
for f in $(git ls-files 'js/*.js' 'js/**/*.js' 2>/dev/null | sort); do
  grep -q "\"/$f\"" sw.js || SW_MISSING="$SW_MISSING $f"
done
if [ -z "$SW_MISSING" ]; then
  ok "all $(git ls-files 'js/*.js' 'js/**/*.js' | wc -l | tr -d ' ') js modules precached in sw.js"
else
  for f in $SW_MISSING; do fail "sw.js APP_SHELL_ASSETS is missing $f"; done
fi

# ── 1b2. The mini-app layering holds ─────────────────────────────────────────
# The whole structure rests on one rule: connectors and shared modules sit BELOW
# mini-apps and must never depend on one. Break it and an app failing to mount
# silently disables a connector — which is exactly what happened when the spots
# connector awaited a global the map app assigned. Apps talk to each other
# through ctx and the bus, never by importing one another.
echo -e "\n${BOLD}Mini-app layering${NC}"
layer_rule() {
  local label="$1" hits
  shift
  # `|| true` is load-bearing: this script runs under `set -euo pipefail`, and a
  # grep that matches nothing exits 1. Without it, the CLEAN case aborted
  # check.sh here — every later check silently skipped, still exiting 0.
  hits=$(grep -rnE "$@" 2>/dev/null | grep -vE ":[0-9]+:\s*(//|\*)" || true)
  if [ -z "$hits" ]; then ok "$label"; else fail "$label"; echo "$hits" | sed 's/^/      /'; fi
}
layer_rule "no connector imports a mini-app" "^import .*from ['\"].*apps/" js/connectors/
layer_rule "no shared module imports a mini-app" "^import .*from ['\"].*apps/" js/utils.js js/grid.js js/psk.js js/bus.js js/vendor.js js/serial-log.js
layer_rule "no mini-app imports another mini-app" "^import .*from ['\"]\.\./[a-z-]+/index\.js" js/apps/
layer_rule "the shell imports no mini-app" "^import .*from ['\"].*apps/" js/shell/
# Every app must export the contract main.js relies on.
APPS_OK=1
for f in js/apps/*/index.js; do
  grep -q "id:" "$f" && grep -q "mount(panelEl, ctx)" "$f" || { fail "$f does not export { id, mount(panelEl, ctx) }"; APPS_OK=0; }
done
[ "$APPS_OK" = "1" ] && ok "all $(ls -d js/apps/*/ | wc -l | tr -d ' ') mini-apps export { id, title, mount }"

# ── 1c. The CSP is stated in four places; keep them in step ──────────────────
# server.js, server.pl and start-server.ps1 each serve the same app locally, and
# _headers serves it on Cloudflare Pages. Four copies is the cost of three
# runtimes plus a static host that cannot import JavaScript — so the drift is
# checked rather than hoped for. Only the directives that actually break
# something when they disagree are compared.
echo -e "\n${BOLD}CSP consistency${NC}"
csp_check() {
  local token="$1" label="$2"
  local missing=""
  for f in server.js server.pl start-server.ps1 _headers; do
    grep -q -- "$token" "$f" || missing="$missing $f"
  done
  if [ -z "$missing" ]; then
    ok "$label present in all four"
  else
    fail "$label missing from:$missing"
  fi
}
csp_check "sha256-PxYpOAntedsUntWSVSNJ8tkM00yECRo0ccasTNtMyaI=" "inline-script hash"
csp_check "ws://localhost:\*" "rigctld bridge (ws://localhost)"
csp_check "api.sotl.as" "SOTA lookup host"
# Leaflet is not vendored, so js/vendor.js falls back to unpkg for BOTH the
# script and the stylesheet. style-src is checked separately because losing it
# fails quietly: the map's JS runs, the tiles load, and the map is unusable
# because none of Leaflet's CSS applied.
csp_check "unpkg.com" "Leaflet CDN host"
csp_check "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com" \
  "Leaflet CDN in style-src"
csp_check "wasm-unsafe-eval" "FT8 WASM"
csp_check "Permissions-Policy" "Permissions-Policy header"
if grep -q "script-src 'self' 'unsafe-inline'" server.js server.pl start-server.ps1 _headers 2>/dev/null; then
  fail "script-src still allows 'unsafe-inline' somewhere — the hash makes it unnecessary"
else
  ok "no 'unsafe-inline' in any script-src"
fi

# ── 1d. The Cloudflare Pages build ships the app and nothing else ────────────
echo -e "\n${BOLD}Cloudflare Pages build${NC}"
if node tools/build-pages.mjs >/tmp/check-pages-out 2>/tmp/check-pages-err; then
  ok "$(head -1 /tmp/check-pages-out)"
  LEAKED=""
  for f in server.js server.pl tools docs package.json check.sh README.md functions; do
    [ -e "dist/$f" ] && LEAKED="$LEAKED $f"
  done
  if [ -z "$LEAKED" ]; then
    ok "dist/ carries no server, tooling, docs or tests"
  else
    fail "dist/ leaked:$LEAKED"
  fi
else
  fail "build-pages failed — $(cat /tmp/check-pages-err)"
fi

# ── 2. Required element IDs in index.html ────────────────────────────────────
echo -e "\n${BOLD}Required IDs in index.html${NC}"
check_id() {
  local id="$1"
  if grep -q "id=\"${id}\"" index.html; then
    ok "#${id}"
  else
    fail "#${id} — MISSING"
  fi
}

# FT8 console — new design
check_id ft8-slot-ring-fill
check_id ft8-countdown
check_id ft8-slot-label
check_id ft8-slot-parity
check_id ft8-tx-status
check_id ft8-next-tx
check_id ft8-waterfall
check_id ft8-text-decodes
check_id ft8-decoder-status
check_id ft8-tx-tone
check_id ft8-audio-device
check_id ft8-fft-size
check_id ft8-queue-cq-btn
check_id ft8-queue-reply-btn
check_id ft8-queue-report-btn
check_id ft8-queue-rrr-btn
check_id ft8-queue-73-btn
check_id ft8-abort-tx-btn
check_id ft8-enable-tx-btn
check_id ft8-start-session-btn
check_id ft8-stop-session-btn
check_id ft8-log-qso-btn
check_id ft8-log-confirm
check_id ft8-log-confirm-callsign
check_id ft8-log-confirm-operator
check_id ft8-log-confirm-time
check_id ft8-log-confirm-grid
check_id ft8-log-confirm-band-mode
check_id ft8-log-confirm-rst
check_id ft8-log-confirm-frequency
check_id ft8-log-confirm-log-btn
check_id ft8-log-confirm-skip-btn
check_id ft8-decode-now-btn
check_id ft8-auto-log-status
check_id ft8-qso-strip
check_id ft8-target-call
# Hidden compat elements
check_id ft8-auto-log
check_id ft8-meter-fill
check_id ft8-noise-floor
check_id ft8-peak-tone
check_id ft8-activity
check_id ft8-frame-buffer
check_id ft8-sync-quality
check_id ft8-last-frame
check_id ft8-qso-stage
check_id ft8-tx-tone-readout
check_id ft8-last-tx
check_id ft8-audio-status

# ── 3. No duplicate IDs ───────────────────────────────────────────────────────
echo -e "\n${BOLD}Duplicate IDs${NC}"
DUPS=$(grep -oP 'id="\K[^"]+' index.html | sort | uniq -d)
if [ -z "$DUPS" ]; then
  ok "no duplicate IDs"
else
  for d in $DUPS; do fail "duplicate: #$d"; done
fi

# ── 4. Key CSS classes referenced in HTML exist in styles.css ────────────────
echo -e "\n${BOLD}CSS classes (spot-check)${NC}"
check_css() {
  local cls="$1"
  if grep -q "\.${cls}[^-]" styles.css; then
    ok ".${cls}"
  else
    fail ".${cls} — not defined in styles.css"
  fi
}
check_css ft8-console-pane
check_css ft8-status-row
check_css ft8-slot-card
check_css ft8-wf-panel
check_css ft8-main-row
check_css ft8-sub-panel
check_css ft8-settings-rail
check_css ft8-tx-actions
check_css ft8-tx-big
check_css ft8-qso-strip
check_css ft8-decode-row
check_css ft8-target-card

# ── 5. Optional screenshot ────────────────────────────────────────────────────
if [ "$SCREENSHOT" = "1" ]; then
  echo -e "\n${BOLD}Screenshot (${TAB})${NC}"

  if ! curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1; then
    _free_port
    info "Starting server on :${PORT}…"
    node server.js >/tmp/webham-server.log 2>&1 &
    _OUR_SERVER_PID=$!
    for i in $(seq 1 25); do
      curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break
      sleep 0.3
    done
    if ! curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1; then
      fail "server did not start — check /tmp/webham-server.log"
    else
      info "server up (pid ${_OUR_SERVER_PID})"
    fi
  else
    info "server already running"
  fi

  OUT="/tmp/webham-${TAB}.png"
  if node dev-screenshot.mjs "$TAB" "$OUT" 2>/tmp/check-shot-err; then
    ok "saved → ${OUT}"
    if command -v kitty >/dev/null 2>&1; then
      kitty +kitten icat --align left "$OUT" 2>/dev/null || true
    elif command -v img2sixel >/dev/null 2>&1; then
      img2sixel "$OUT" 2>/dev/null || true
    else
      info "view with: xdg-open ${OUT}"
    fi
  else
    fail "screenshot failed — $(cat /tmp/check-shot-err)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All checks passed.${NC}"
else
  echo -e "${RED}${BOLD}${FAILURES} check(s) failed.${NC}"
  exit 1
fi
