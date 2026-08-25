// The activity log strip (#serial-log) — one implementation, shared.
//
// There were eight `appendSerialLog` functions: six byte-identical copies that
// wrote the textarea directly, plus two in the FT8 and logger apps that
// dispatched a bus "serial-log" event which the RADIO app listened for and
// forwarded to its own identical copy. That indirection had a real failure mode —
// if the radio app ever failed to mount, every FT8 and logger line was dropped on
// the floor with nothing to show for it. The textarea is shell chrome, not radio
// chrome, so nothing should have to route through a mini-app to write to it.
//
// Two problems fixed along the way, both of which the copies shared:
//
//   Unbounded growth. Nothing ever trimmed the log. With a radio connected the
//   CAT poll writes a line roughly every second, and each append rebuilt the
//   whole string — so an hour of operating meant a multi-megabyte textarea value
//   and an O(n) copy per line. Capped at MAX_LINES now.
//
//   Scroll stealing. It set scrollTop to the bottom on every line, so scrolling
//   up to read something older yanked you back down on the next poll. It now
//   only follows when you are already at the bottom.
const MAX_LINES = 500;

// The element is resolved lazily and re-resolved when detached: the pane manager
// MOVES panels between panes and the pool, so a reference captured at mount time
// stays valid, but a lazily-cached one must survive the node being replaced.
let cached = null;
function target() {
  if (!cached || !cached.isConnected) cached = document.querySelector("#serial-log");
  return cached;
}

export function appendSerialLog(message) {
  const el = target();
  if (!el) return;

  // Within a couple of pixels of the bottom counts as "following".
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;

  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  const next = el.value ? `${el.value}\n${line}` : line;

  // Trim from the front only when over the cap, so the common case is a plain
  // append and the split/slice/join runs about once every MAX_LINES lines.
  const lineCount = countLines(next);
  el.value = lineCount > MAX_LINES
    ? next.split("\n").slice(lineCount - MAX_LINES).join("\n")
    : next;

  if (atBottom) el.scrollTop = el.scrollHeight;
}

function countLines(text) {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
