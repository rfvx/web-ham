// Generates the app icons from code, so there is no binary asset in the repo
// that nobody can regenerate or adjust.
//
//   node tools/make-icons.mjs
//
// Why this exists at all: a web app manifest with no `icons` array is not
// installable. Chromium simply never offers "Install app", with no error and
// nothing in the console — the feature is just absent. The manifest had no
// icons, so PWA install had never worked on a deployment.
//
// PNGs are written by hand rather than with a canvas or an image library: this
// repo has no dependencies and is not about to grow one for four icons. A PNG is
// a signature, an IHDR, a zlib-deflated block of RGBA scanlines and an IEND,
// which is about forty lines of code.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GROUND = [0x0b, 0x12, 0x20]; // manifest background_color
const MARK = [0xc7, 0x5a, 0x2f]; // --accent

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

// rgba: a Uint8ClampedArray of size*size*4.
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, at + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the mark ─────────────────────────────────────────────────────────────────
//
// A mast on a base, radiating two arcs from each side of its feed point: an
// antenna transmitting. The arcs flank the mast rather than fanning upward from
// a dot, which is the whole difference between this and the Wi-Fi glyph.
//
// Drawn as a coverage function over unit coordinates and supersampled 4x4 per
// pixel, which is what keeps the curves smooth at 192px with no drawing API.

const DEG = Math.PI / 180;

// Coverage of the mark at unit point (x, y), both in [0, 1].
// `scale` shrinks the whole mark toward the centre for the maskable variant.
// `weight` thickens every stroke and `arcs` chooses how many to strike: at 32px
// the two-arc mark at normal weight renders as a smudge, so the favicon drops
// the outer arc and draws the rest heavier.
function markAt(x, y, scale, weight, arcs) {
  // Work in mark-space: centred on the canvas, then scaled.
  const mx = (x - 0.5) / scale;
  const my = (y - 0.5) / scale;

  const FEED = -0.20; // height of the feed point, where the arcs originate
  const FOOT = 0.34; // height of the base

  if (my >= FEED && my <= FOOT && Math.abs(mx) <= 0.030 * weight) return true;
  // Base.
  const foot = 0.030 * weight;
  if (my >= FOOT - foot && my <= FOOT + foot && Math.abs(mx) <= 0.185) return true;
  // Feed point.
  const r = Math.hypot(mx, my - FEED);
  if (r <= 0.062 * weight) return true;

  // Arcs on each side of the feed point, struck between 30 and 86 degrees off
  // vertical so they open sideways and leave the mast clear.
  const angle = Math.abs(Math.atan2(mx, -(my - FEED)));
  if (angle < 30 * DEG || angle > 86 * DEG) return false;
  const half = 0.030 * weight;
  return arcs.some((radius) => Math.abs(r - radius) <= half);
}

// 0.86 leaves the outer arc a margin off the canvas edge; at 1.0 it clips.
function render(size, { scale = 0.86, round = false, weight = 1, arcs = [0.165, 0.290] } = {}) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const SS = 4; // supersampling factor per axis
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      let inside = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          // A rounded ground for the favicon/any-purpose icons; maskable icons
          // must fill the square edge to edge because the platform crops them.
          const withinGround = round ? Math.hypot(x - 0.5, y - 0.5) <= 0.5 : true;
          if (withinGround) inside += 1;
          if (withinGround && markAt(x, y, scale, weight, arcs)) hits += 1;
        }
      }
      const total = SS * SS;
      const groundA = inside / total;
      const markA = hits / total;
      const at = (py * size + px) * 4;
      // Mark over ground, ground over transparent.
      for (let c = 0; c < 3; c += 1) {
        rgba[at + c] = (MARK[c] * markA + GROUND[c] * (groundA - markA)) / (groundA || 1);
      }
      rgba[at + 3] = groundA * 255;
    }
  }
  return rgba;
}

const ICONS = [
  // Chromium needs a 192 and a 512 to consider the app installable.
  { file: "icons/icon-192.png", size: 192 },
  { file: "icons/icon-512.png", size: 512 },
  // Maskable: the platform crops to its own shape, so the mark is pulled into
  // the safe zone and the ground fills the full square.
  { file: "icons/icon-maskable-512.png", size: 512, opts: { scale: 0.62 } },
  // Small enough that the rounded ground reads as a favicon rather than a blob.
  { file: "icons/favicon-32.png", size: 32, opts: { round: true, scale: 0.74, weight: 1.7, arcs: [0.235] } },
];

mkdirSync(join(ROOT, "icons"), { recursive: true });
for (const { file, size, opts } of ICONS) {
  const png = encodePng(size, render(size, opts));
  writeFileSync(join(ROOT, file), png);
  process.stdout.write(`  ${file}  ${size}x${size}  ${png.length} bytes\n`);
}
