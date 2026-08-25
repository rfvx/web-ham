// First-run guide — shell chrome that belongs to no tab.
//
// WebHam opens on the FT8 console and a Logbook, with a radio it has not been
// told about and a callsign it does not know. Nothing on that screen says that
// the station identity in Settings is what FT8 messages, ADIF exports and LoTW
// uploads are all built from, so the commonest first session is one where every
// logged contact carries UNKNOWN as its station callsign. These cards say so
// before that happens — and one of them will not let you past until it is true.
//
// Design notes worth keeping:
//
// - It points at the real interface. A card can name a SPOTLIGHT target: the
//   guide reveals whatever tab holds it, dims the page around it, and rings it.
//   "Where do I set my callsign" is a question a screenshot-free paragraph
//   cannot answer, and an operator who has been shown the actual Settings card
//   once can find it again. Describing the UI and pointing at it are not the
//   same thing, and only the second survives a redesign of the words.
//
// - It stays modal throughout. With a spotlight the scrim carries a clip-path
//   hole over the target's bounds, so the highlighted control is the one thing
//   on the page still clickable and everything else swallows the click; without
//   one, the scrim covers everything and every sibling of the dialog inside
//   .wh-app is `inert` as well. Either way the app cannot be wandered off into.
//   Skip and Escape are the ways out, and both are always offered.
//
// - Only "Basic info" gates. It watches the real Settings fields and keeps Next
//   disabled until both hold something valid. "Other info" just describes two
//   optional set-ups and never blocks — a guide that insists on an ARRL
//   account before it will let go is a guide that gets skipped. "Get
//   operating" is a sign-off with nothing after it to proceed to, so gating
//   it could only trap people.
//
// - It runs ONCE. The flag is set the moment the guide is shown, not when it is
//   finished, so a visitor who closes the tab mid-guide is not met with it again
//   on the next visit. Reopening is a deliberate act (the "?" button in the
//   notice strip), which is the behaviour people expect from a welcome tour.
//
// - Nothing here blocks boot. The markup ships in index.html hidden, and this
//   module only ever shows it, so a failure to show the guide cannot stop the
//   app from mounting.
import { bus } from "../bus.js";
import { settings } from "../connectors/settings.js";

const SEEN_KEY = "web-ham-logger.guide-seen";

// Same shape js/apps/ft8/decode.js validates against: a 4-character Maidenhead
// field-square, optionally with the 2-character subsquare.
const GRID_RE = /^[A-R]{2}\d{2}([A-X]{2})?$/;
// Deliberately loose. Callsigns are alphanumeric with optional /P, /M, /QRP or
// a DXpedition prefix, and every tight regex anyone writes rejects somebody's
// real, issued call. This rejects the things that are certainly not a callsign
// — punctuation, spaces, one or two characters — and lets the rest through.
const CALL_RE = /^[A-Z0-9]+(\/[A-Z0-9]+)*$/;
const isCall = (v) => v.length >= 3 && CALL_RE.test(v);

// The real controls a card can point at. Held as selectors rather than elements
// because most of them do not exist until the shell has built its panes.
const TARGETS = {
  addTab: () => document.querySelector(".wh-tab-add-btn"),
  stationIdentity: () => document.querySelector("#settings-station-identity"),
  lotwSection: () => document.querySelector("#settings-lotw-section"),
  guideButton: () => document.querySelector("#wh-notice-guide"),
};

// The Settings fields the identity gate watches. The operator types in these,
// not in anything the guide owns.
const field = (id) => document.querySelector(id);
const identityValues = () => ({
  call: (field("#ft8-my-call")?.value || "").trim().toUpperCase(),
  grid: (field("#ft8-my-grid")?.value || "").trim().toUpperCase(),
  stationCall: (field("#settings-station-call")?.value || "").trim().toUpperCase(),
});

// `spotlight` names a TARGETS key; `tab`/`category` are what must be showing for
// that target to exist on screen. `gate: true` means Next stays disabled until
// the card's task is done.
const STEPS = [
  {
    title: "Welcome to WebHam",
    body:
      "A versatile ham radio web app that lets many different apps run off one connection to the " +
      "radio, all in the browser.",
    note:
      "Make sure you are on an up-to-date Chrome or Chromium browser (Edge, Brave, Opera) or Firefox. " +
      "Talking to a radio needs Web Serial, which is desktop-only; everything else works anywhere.",
  },
  {
    title: "The mini-app system",
    body:
      "One of WebHam's greatest features is the mini-app system. It lets many different modes of " +
      "operating happen without switching applications and configuring settings for each one. " +
      "Everything is its own mini-app — there is an FT8 mini-app, a logbook mini-app, a map mini-app. " +
      "You open them with the plus icon, and move them around and maximise them just like a tab in a " +
      "browser.",
    note: "Two panes side by side on a desktop; on a phone, one view at a time from the tab strip.",
    spotlight: "addTab",
    // The "+" opens a dropdown of its own, anchored to the button and growing
    // rightward from it. Docking the card on the left keeps the two apart
    // instead of centring the card into the dropdown's path.
    cardSide: "left",
  },
  {
    title: "Basic info",
    body:
      "The callsign and grid square you set in Settings are shared between all the different " +
      "mini-apps. They are used for FT8 exchanges, ADIF exports, your position on the map, and " +
      "anything you send to LoTW.",
    note: "Contacts logged before these are set carry UNKNOWN as the station callsign.",
    spotlight: "stationIdentity",
    tab: "settings",
    category: "operator",
    task: "identity",
    gate: true,
  },
  {
    title: "Other info",
    body:
      "You can set up LoTW sync, or set up callsign lookup with HamQTH or QRZ, if you want. Neither " +
      "is needed to log a contact. WebHam signs LoTW uploads itself, so a station certificate is all " +
      "it needs — no TQSL install.",
    note: "LoTW is the highlighted panel. Callsign lookup is under Operator, in the list on the left.",
    spotlight: "lotwSection",
    tab: "settings",
    category: "logging",
  },
  {
    title: "Get operating!",
    body:
      "Have fun operating with WebHam! You can come back to this guide from the top yellow bar, " +
      "where you will also find some other important information about WebHam.",
    spotlight: "guideButton",
  },
];

let els = null;
let index = 0;
// Every .wh-app child made inert for the duration, so the undo is exactly what
// was done rather than a guess.
let inerted = [];
// The element the current card is pointing at, and the rAF handle for the
// reposition that follows it around.
let spotEl = null;
let spotFrame = 0;

/* ---- the gate ---- */

function identityDone() {
  const { call, grid } = identityValues();
  return isCall(call) && GRID_RE.test(grid);
}

// Returns "" when the card is satisfied, otherwise the reason — which doubles
// as the message under the checklist, so there is never a disabled Next button
// with nothing saying why.
function identityProblem() {
  const { call, grid } = identityValues();
  if (!call && !grid) return "";
  if (call && !isCall(call)) return `"${call}" does not look like a callsign.`;
  if (grid && !GRID_RE.test(grid)) return `"${grid}" is not a Maidenhead grid. Try FN31 or FN31pr.`;
  return "";
}

// Called when the gate is passed. The Settings tab persists My grid on every
// keystroke of its own accord, but My callsign and the ADIF station call only
// mark the form dirty — so without this an operator who followed the guide
// exactly and never pressed Save would still log UNKNOWN. Silent: the form is
// already showing these values, so there is nothing to re-render.
function persistIdentity() {
  const { call, grid, stationCall } = identityValues();
  if (!isCall(call) || !GRID_RE.test(grid)) return;
  settings.set({
    ...settings.get(),
    ft8MyCall: call,
    ft8MyGrid: grid,
    // One answer, shared: the brief says the callsign is common to every
    // mini-app, so an empty ADIF station call inherits it rather than being a
    // second thing to remember. A deliberate different value is left alone.
    stationCall: stationCall || call,
  }, { silent: true });
  const el = field("#settings-station-call");
  if (el && !el.value.trim()) el.value = call;
}

/* ---- the spotlight ---- */

function clearSpotlight() {
  spotEl = null;
  els.ring.hidden = true;
  els.scrim.style.clipPath = "";
  els.root.classList.remove(
    "wh-guide-spotlit", "wh-guide-docked-top", "wh-guide-docked-bottom",
    "wh-guide-docked-left", "wh-guide-docked-right"
  );
}

// Punch the hole and draw the ring. Called on every reposition, so it must be
// cheap and must cope with a target that has scrolled out of view or been
// unmounted since the card opened.
function placeSpotlight() {
  if (!spotEl) return;
  const r = spotEl.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) {
    // Target is gone or hidden. Fall back to a plain modal rather than a hole
    // over nothing, which would leave the operator staring at a ring in a
    // corner and no way to do the task.
    clearSpotlight();
    return;
  }
  const pad = 6;
  const x1 = Math.max(0, r.left - pad);
  const y1 = Math.max(0, r.top - pad);
  const x2 = Math.min(window.innerWidth, r.right + pad);
  const y2 = Math.min(window.innerHeight, r.bottom + pad);

  // Outer ring clockwise, inner ring counter-clockwise: under the default
  // nonzero fill rule that leaves a hole, and clipped-away area does not take
  // pointer events, so the target stays clickable and the rest does not.
  // Written this way rather than with `polygon(evenodd, ...)` so it does not
  // depend on fill-rule support in clip-path.
  els.scrim.style.clipPath =
    `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ` +
    `${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;

  els.ring.hidden = false;
  els.ring.style.left = `${x1}px`;
  els.ring.style.top = `${y1}px`;
  els.ring.style.width = `${x2 - x1}px`;
  els.ring.style.height = `${y2 - y1}px`;

  // Keep the card off the thing it is pointing at: if the target sits in the
  // top half of the viewport the card goes to the bottom, and vice versa.
  const below = (r.top + r.bottom) / 2 < window.innerHeight / 2;
  els.root.classList.add("wh-guide-spotlit");
  els.root.classList.toggle("wh-guide-docked-bottom", below);
  els.root.classList.toggle("wh-guide-docked-top", !below);

  // A step can also name which side is safe (see addTab's cardSide), for a
  // target with a dropdown of its own that a plain top/bottom dock would
  // still land on.
  const side = STEPS[index].cardSide;
  els.root.classList.toggle("wh-guide-docked-left", side === "left");
  els.root.classList.toggle("wh-guide-docked-right", side === "right");
}

function scheduleSpotlight() {
  if (spotFrame) return;
  spotFrame = requestAnimationFrame(() => { spotFrame = 0; placeSpotlight(); });
}

// Reveal whatever the card points at, then measure it. The two rAFs are not
// superstition: "activate-tab" and the category switch both change layout, and
// a rect read in the same frame is the pre-switch one.
function openSpotlight(step) {
  clearSpotlight();
  if (!step.spotlight) return;
  if (step.tab) bus.dispatchEvent(new CustomEvent("activate-tab", { detail: step.tab }));
  if (step.category) bus.dispatchEvent(new CustomEvent("settings-show-category", { detail: step.category }));

  requestAnimationFrame(() => requestAnimationFrame(() => {
    // A card change between scheduling and running would otherwise spotlight
    // the previous card's target.
    if (STEPS[index] !== step) return;
    const el = TARGETS[step.spotlight]?.();
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "auto" });
    spotEl = el;
    placeSpotlight();

    // One correction pass. The card docks away from the target, but on a narrow
    // screen the sheet is most of the viewport, so "away" is not far enough and
    // it can still land on top of what it is pointing at. Push the target to the
    // far edge instead, then re-measure.
    requestAnimationFrame(() => {
      if (spotEl !== el) return;
      const t = el.getBoundingClientRect();
      const c = els.card.getBoundingClientRect();
      if (t.top >= c.bottom || t.bottom <= c.top) return;
      el.scrollIntoView({
        block: els.root.classList.contains("wh-guide-docked-bottom") ? "start" : "end",
        behavior: "auto",
      });
      placeSpotlight();
    });
  }));
}

/* ---- rendering ---- */

function renderIdentity() {
  const problem = identityProblem();
  els.identityStatus.textContent = problem
    || (identityDone() ? "That is everything — these are saved." : "Fill in My callsign and My grid in the highlighted panel.");
  els.identityStatus.classList.toggle("wh-guide-task-status-bad", !!problem);
  els.next.disabled = !identityDone();
}

function render() {
  const step = STEPS[index];
  els.title.textContent = step.title;
  els.body.textContent = step.body;
  els.note.textContent = step.note || "";
  els.note.hidden = !step.note;
  els.count.textContent = `${index + 1} of ${STEPS.length}`;
  els.back.hidden = index === 0;

  els.identityStatus.hidden = step.task !== "identity";

  els.next.disabled = false;
  if (step.task === "identity") renderIdentity();

  els.next.textContent = index === STEPS.length - 1 ? "Start operating" : "Next";
  // The dots are decorative; the "n of m" line is what assistive tech reads.
  [...els.dots.children].forEach((dot, i) => dot.classList.toggle("wh-guide-dot-on", i === index));

  // Blocking follows the card. A spotlight needs its target reachable, so those
  // cards rely on the scrim's hole alone; a card with nothing to point at gets
  // `inert` on top of the scrim, which also takes the app out of the tab order
  // and out of the accessibility tree.
  releaseInert();
  if (!step.spotlight) applyInert();
  openSpotlight(step);
}

/* ---- open / close ---- */

function applyInert() {
  inerted = [...(els.root.parentElement?.children || [])].filter((el) => el !== els.root);
  inerted.forEach((el) => { el.inert = true; });
}

function releaseInert() {
  inerted.forEach((el) => { el.inert = false; });
  inerted = [];
}

function close() {
  els.root.hidden = true;
  releaseInert();
  clearSpotlight();
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("input", onDocumentInput, true);
  window.removeEventListener("resize", scheduleSpotlight);
  window.removeEventListener("scroll", scheduleSpotlight, true);
}

function advance() {
  const step = STEPS[index];
  // Belt and braces: the button is disabled, but a stale click reaches here
  // without going through it.
  if (step.gate === true && !identityDone()) return;
  if (step.task === "identity") persistIdentity();
  if (index === STEPS.length - 1) {
    close();
    return;
  }
  index += 1;
  render();
  els.next.focus();
}

// The gate watches the Settings fields, which the guide does not own. One
// capturing document listener rather than listeners bound to each input: those
// inputs exist before the guide opens but the guide can open and close many
// times, and unbinding cleanly matters more than the handful of no-op calls.
function onDocumentInput(event) {
  if (STEPS[index].task !== "identity") return;
  if (!(event.target instanceof HTMLInputElement)) return;
  if (!["ft8-my-call", "ft8-my-grid", "settings-station-call"].includes(event.target.id)) return;
  renderIdentity();
}

function onKeydown(event) {
  // Escape is Skip. The guide gates, but it is never a trap — the way out is
  // the same one the Skip button offers, and Escape is where people look first.
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  // Focus trap, but only where there is nothing else the operator is meant to
  // reach. On a spotlight card the target is exactly what they need to tab
  // into, so the card must not claw focus back off it.
  if (STEPS[index].spotlight) return;
  const stops = [...els.card.querySelectorAll("a[href], button:not([disabled]), input:not([disabled])")]
    .filter((el) => !el.hidden && el.offsetParent !== null);
  if (stops.length === 0) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openGuide() {
  if (!els) return;
  index = 0;
  els.root.hidden = false;
  render();
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("input", onDocumentInput, true);
  window.addEventListener("resize", scheduleSpotlight);
  // Capturing: the panes scroll internally, and a target that scrolls out from
  // under its own ring is worse than no ring at all.
  window.addEventListener("scroll", scheduleSpotlight, true);
  els.next.focus();
}

export function mountOnboarding() {
  const root = document.querySelector("#wh-guide");
  if (!root) return;

  els = {
    root,
    scrim: root.querySelector("#wh-guide-scrim"),
    ring: root.querySelector("#wh-guide-ring"),
    card: root.querySelector("#wh-guide-cardel"),
    title: root.querySelector("#wh-guide-title"),
    body: root.querySelector("#wh-guide-body"),
    note: root.querySelector("#wh-guide-note"),
    count: root.querySelector("#wh-guide-count"),
    dots: root.querySelector("#wh-guide-dots"),
    back: root.querySelector("#wh-guide-back"),
    next: root.querySelector("#wh-guide-next"),
    skip: root.querySelector("#wh-guide-skip"),
    identityStatus: root.querySelector("#wh-guide-identity-status"),
  };
  if (Object.values(els).some((el) => !el)) {
    els = null;
    return;
  }

  STEPS.forEach(() => {
    const dot = document.createElement("span");
    dot.className = "wh-guide-dot";
    els.dots.appendChild(dot);
  });

  els.next.addEventListener("click", advance);
  els.back.addEventListener("click", () => { index = Math.max(0, index - 1); render(); els.next.focus(); });
  els.skip.addEventListener("click", close);

  // No dismiss-on-scrim-click. On a gating card that would be a way past the
  // gate that nothing announces, and it is far too easy to hit by accident on
  // the mobile bottom sheet.

  let seen = true;
  try {
    seen = localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Storage denied (private mode, blocked cookies). Showing the guide every
    // visit would be worse than never showing it, so treat it as seen.
  }
  if (seen) return;

  // Marked before the guide is shown, not after it is finished: a visitor who
  // closes the tab on card two should not be greeted by it again.
  try { localStorage.setItem(SEEN_KEY, "1"); } catch {}
  openGuide();
}
