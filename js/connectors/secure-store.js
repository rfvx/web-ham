// Secure store — credentials encrypted at rest.
//
// WebHam holds real secrets: the QRZ / HamQTH / LoTW account passwords and the
// LoTW station certificate (.p12). The owner's requirement is that these
// PERSIST across reloads (unlike a session-only store) but are never written to
// disk in plaintext.
//
// Design:
//   - An AES-GCM 256-bit key generated with `extractable: false` and stored as a
//     CryptoKey object in IndexedDB. Non-extractable means `crypto.subtle.
//     exportKey` refuses, so even a full profile/IndexedDB dump cannot yield the
//     raw key bytes — the key can only be USED (encrypt/decrypt) by code running
//     as this origin.
//   - Secrets live as one AES-GCM ciphertext blob (random 12-byte IV per write)
//     in localStorage. A storage export is therefore ciphertext + an
//     unexportable key: useless on its own.
//   - At boot, initSecureStore() loads the key and decrypts the blob into an
//     in-memory cache, so getSecret() stays synchronous for callers (lookup,
//     logger). Writes update the cache synchronously and persist (re-encrypt)
//     asynchronously, serialised so concurrent writes can't interleave.
//
// What this is NOT: a defence against active XSS. Script running on this origin
// can call decrypt just as the app does. It removes plaintext-at-rest —
// profile sync, backups, a devtools Storage glance, anything that copies
// storage without executing in the page — which is what "safe and encrypted at
// rest" means here.
import { KEYS } from "./settings.js";
import { bytesToBase64 } from "../utils.js";

const SECURE_BLOB_KEY = "web-ham-logger.secure";      // localStorage: ciphertext
const IDB_NAME = "web-ham-secure";
const IDB_STORE = "keys";
const IDB_KEY_ID = "master";

// Password fields that used to live plaintext in the settings blob, plus the
// p12 meta that used to live under LOTW_P12_KEY. These are migrated out on boot.
const MIGRATED_SETTINGS_SECRETS = ["qrzPass", "hamqthPass", "lotwPass", "lotwP12Pass"];
const P12_SECRET = "lotwP12Meta"; // cache key holding { name, data } for the .p12

let cache = Object.create(null);
let cryptoKey = null;
let persistChain = Promise.resolve();
let ready = false;

// ── IndexedDB: the non-extractable master key ───────────────────────────────
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function loadOrCreateKey() {
  const db = await idbOpen();
  let key = await idbGet(db, IDB_KEY_ID);
  if (!key) {
    // extractable:false is the whole point — the key can be stored and used but
    // its bytes can never be read back out.
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbPut(db, IDB_KEY_ID, key);
  }
  db.close();
  return key;
}

// ── AES-GCM encode/decode of the secrets object (exported for unit testing) ──
export async function encryptWithKey(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  // Chunked: the blob includes the LoTW .p12, so spreading it into
  // String.fromCharCode threw RangeError on real certificates. See bytesToBase64.
  return bytesToBase64(out);
}

export async function decryptWithKey(key, blob) {
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// Raised when a write cannot reach disk, so the UI can say so instead of letting
// the operator believe a password was saved. Listeners get { detail: reason }.
export const secureStore = new EventTarget();

function persist() {
  // Serialise writes: chain each re-encrypt after the previous so a burst of
  // setSecret() calls can't race to write stale ciphertext.
  const snapshot = JSON.stringify(cache);
  persistChain = persistChain.then(async () => {
    if (!cryptoKey) {
      // No key means initSecureStore() found no WebCrypto or no IndexedDB —
      // typically the page is on plain http://, which is not a secure context.
      // Secrets then live for the session only, and saying nothing meant the
      // operator typed a password, saw it accepted, and found it gone on reload.
      secureStore.dispatchEvent(new CustomEvent("persist-failed", {
        detail: "No secure storage available — credentials will be forgotten when this tab closes. "
              + "Open WebHam over https:// to store them encrypted.",
      }));
      return;
    }
    try {
      localStorage.setItem(SECURE_BLOB_KEY, await encryptWithKey(cryptoKey, snapshot));
    } catch (e) {
      console.warn("secure-store persist failed", e);
      secureStore.dispatchEvent(new CustomEvent("persist-failed", {
        detail: `Couldn't save credentials (${e.name === "QuotaExceededError" ? "browser storage is full" : e.message}).`,
      }));
    }
  });
  return persistChain;
}

// One-time migration: lift any plaintext credentials out of the settings blob
// and the plaintext LOTW_P12_KEY into the encrypted cache, then strip the
// plaintext. Returns true if it moved anything.
function migratePlaintext() {
  let moved = false;
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS.SETTINGS_KEY) || "{}");
    if (raw && typeof raw === "object") {
      let touched = false;
      for (const name of MIGRATED_SETTINGS_SECRETS) {
        if (raw[name]) { cache[name] = String(raw[name]); moved = true; }
        if (name in raw) { delete raw[name]; touched = true; }
      }
      if (touched) localStorage.setItem(KEYS.SETTINGS_KEY, JSON.stringify(raw));
    }
  } catch { /* ignore malformed settings */ }
  try {
    const p12 = localStorage.getItem(KEYS.LOTW_P12_KEY);
    if (p12) {
      cache[P12_SECRET] = p12;               // stored as its JSON string
      localStorage.removeItem(KEYS.LOTW_P12_KEY);
      moved = true;
    }
  } catch { /* ignore */ }
  return moved;
}

// Boot: load the key, decrypt the stored blob into the cache, migrate any
// plaintext, and persist if migration moved something. Safe to call once.
export async function initSecureStore() {
  if (typeof indexedDB === "undefined" || !crypto?.subtle) {
    // No crypto/IDB (very old browser or a non-secure context): degrade to an
    // in-memory-only store for the session rather than fall back to plaintext.
    ready = true;
    return { ok: false, reason: "no-webcrypto-or-idb" };
  }
  try {
    cryptoKey = await loadOrCreateKey();
    const blob = localStorage.getItem(SECURE_BLOB_KEY);
    if (blob) {
      try {
        cache = JSON.parse(await decryptWithKey(cryptoKey, blob)) || Object.create(null);
      } catch {
        cache = Object.create(null); // wrong key / tampered blob — start clean
      }
    }
    const moved = migratePlaintext();
    ready = true;
    if (moved) await persist();
    return { ok: true, migrated: moved };
  } catch (e) {
    ready = true;
    return { ok: false, reason: String(e) };
  }
}

// ── Synchronous cache accessors for consumers ───────────────────────────────
export function getSecret(name) {
  return cache[name] || "";
}

export function setSecret(name, value) {
  if (value) cache[name] = String(value);
  else delete cache[name];
  persist();
}

export function getLotwP12Meta() {
  const raw = cache[P12_SECRET];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setLotwP12Meta(meta) {
  if (meta) cache[P12_SECRET] = JSON.stringify(meta);
  else delete cache[P12_SECRET];
  persist();
}

export function clearSecrets() {
  cache = Object.create(null);
  persist();
}

export function isReady() {
  return ready;
}

// Await all pending persists — used by tests to observe the ciphertext.
export function flush() {
  return persistChain;
}
