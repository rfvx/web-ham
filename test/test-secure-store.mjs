// Unit tests for the crypto core of js/connectors/secure-store.js:
// encryptWithKey / decryptWithKey. Run: node test-secure-store.mjs
//
// IndexedDB doesn't exist in node, so the key-storage + cache layer is verified
// in the browser gate (cdp-secure-store). Here we test the AES-GCM round-trip,
// tamper detection, and wrong-key rejection against a real WebCrypto key —
// node 22 provides globalThis.crypto.subtle.
//
// secure-store.js imports KEYS from settings.js, which touches localStorage at
// import; stub it so the module loads headless.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { encryptWithKey, decryptWithKey } = await import("../js/connectors/secure-store.js");

let passed = 0, failed = 0;
function assert(c, m) { if (c) passed++; else { failed++; console.error("FAIL:", m); } }
function eq(a, b, m) { assert(a === b, `${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

// ── round-trip ──────────────────────────────────────────────────────────────
const secret = JSON.stringify({ qrzPass: "hunter2", lotwP12Meta: '{"name":"cert.p12"}' });
const blob = await encryptWithKey(key, secret);
eq(await decryptWithKey(key, blob), secret, "round-trips arbitrary JSON secret blob");

// ── the ciphertext must NOT contain the plaintext ───────────────────────────
assert(!blob.includes("hunter2"), "ciphertext does not leak the plaintext password");
assert(atob(blob).length > secret.length, "blob carries IV + GCM tag beyond the plaintext length");

// ── a fresh IV per encryption (same input -> different ciphertext) ──────────
const b2 = await encryptWithKey(key, secret);
assert(blob !== b2, "each encryption uses a fresh IV, so ciphertext differs");
eq(await decryptWithKey(key, b2), secret, "...and both still decrypt to the same plaintext");

// ── tamper detection: flipping a ciphertext byte fails GCM auth ─────────────
{
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff; // corrupt the last (tag) byte
  const tampered = btoa(String.fromCharCode(...bytes));
  let threw = false;
  try { await decryptWithKey(key, tampered); } catch { threw = true; }
  assert(threw, "a tampered ciphertext is rejected (GCM authentication)");
}

// ── wrong key cannot decrypt ────────────────────────────────────────────────
{
  const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  let threw = false;
  try { await decryptWithKey(other, blob); } catch { threw = true; }
  assert(threw, "a different key cannot decrypt the blob");
}

// ── the generated key is non-extractable (defence-in-depth on our own use) ──
{
  let threw = false;
  try { await crypto.subtle.exportKey("raw", key); } catch { threw = true; }
  assert(threw, "a non-extractable AES-GCM key refuses exportKey");
}

// ── empty / unicode payloads survive ────────────────────────────────────────
eq(await decryptWithKey(key, await encryptWithKey(key, "")), "", "empty string round-trips");
const uni = '{"n":"café — 日本語 — 🛰"}';
eq(await decryptWithKey(key, await encryptWithKey(key, uni)), uni, "unicode round-trips");

// ── a real .p12 does not blow the call stack ────────────────────────────────
//
// encryptWithKey used to finish with `btoa(String.fromCharCode(...bytes))`, one
// argument per byte, which throws RangeError once the blob is large enough —
// about 128 KB in V8 and lower in Safari. The blob holds the LoTW station
// certificate, so this was reachable with an ordinary certificate and a couple
// of saved passwords, and it failed silently: persist() only console.warns, so
// the secret simply never reached disk.
{
  const bigP12 = "A".repeat(400 * 1024); // base64 of a large-but-plausible cert
  const payload = JSON.stringify({ lotwP12Meta: JSON.stringify({ name: "big.p12", data: bigP12 }) });
  let roundTripped = null;
  try {
    roundTripped = await decryptWithKey(key, await encryptWithKey(key, payload));
  } catch (error) {
    assert(false, `400 KB secret blob threw ${error.constructor.name}: ${error.message}`);
  }
  // Compared with assert, not eq: eq puts both values in the failure message,
  // and these are 400 KB each.
  assert(roundTripped === payload, "a 400 KB secret blob (large .p12) round-trips without RangeError");
}

// bytesToBase64 must agree byte-for-byte with the naive version it replaced,
// across and beyond the chunk boundary.
{
  const { bytesToBase64 } = await import("../js/utils.js");
  for (const size of [0, 1, 255, 0x8000 - 1, 0x8000, 0x8000 + 1, 100_000]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const expected = Buffer.from(bytes).toString("base64");
    eq(bytesToBase64(bytes), expected, `bytesToBase64 matches for ${size} bytes`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
