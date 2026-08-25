// Local development server. Serves the app and the four /api/* endpoints that
// Cloudflare Pages serves as Functions; the LoTW signer is the same module both
// use (functions/_lib/tq8.js), so the two agree by construction.
//
// child_process, os and zlib used to be required here for the openssl-based LoTW
// signer — four subprocess calls and a temp directory that briefly held the
// operator's private key on disk. The portable signer needs none of them.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 4173;
// Bind loopback by default. This server holds the operator's LoTW p12 and
// proxies their QRZ/HamQTH/LoTW credentials, none of which should be reachable
// from the LAN over plaintext HTTP. Set HOST=0.0.0.0 deliberately (behind TLS
// and/or a trusted proxy) if remote access is actually wanted.
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const LOTW_DRY_RUN = process.env.LOTW_DRY_RUN === "1";
// Set TRUST_PROXY=1 when running behind a trusted reverse proxy (Railway, Fly, nginx on
// the same host, etc.) so X-Forwarded-For is used for per-IP rate limiting. Without it
// all requests behind the proxy share one IP and rate limits are effectively per-server.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

// Sliding-window rate limiter: Map<"bucket:ip", timestamp[]>
const rateLimitBuckets = new Map();

function getClientIp(req) {
  const remote = req.socket.remoteAddress || "";
  // Only honour X-Forwarded-For when a proxy is explicitly configured. The old
  // code also trusted it whenever remoteAddress was loopback — which is the
  // normal case for this server — so same-origin JS could spoof a fresh IP per
  // request and bypass every rate limit (burning the QRZ quota, and turning
  // /api/lotw/download into an unthrottled password oracle against ARRL).
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return fwd.split(",")[0].trim();
  }
  return remote.trim();
}

// Hosts the API will answer to. Loopback names always; whatever HOST was set to
// when it is not a wildcard; plus anything in ALLOWED_HOSTS (comma-separated) so
// a real deployment can name itself. When HOST is a wildcard we cannot enumerate
// the machine's addresses, so the allowlist is skipped and only the
// Origin === Host check applies — that is the operator explicitly opting into
// LAN exposure, and it is called out in the README.
const HOST_IS_WILDCARD = HOST === "0.0.0.0" || HOST === "::";
const ALLOWED_API_HOSTS = new Set(
  [
    `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`,
    ...(HOST_IS_WILDCARD ? [] : [`${HOST}:${PORT}`]),
    ...String(process.env.ALLOWED_HOSTS || "").split(",").map(h => h.trim()).filter(Boolean),
  ]
);

function isAllowedApiHost(hostHeader) {
  if (HOST_IS_WILDCARD) return true;
  return ALLOWED_API_HOSTS.has(String(hostHeader || "").toLowerCase());
}

function checkRateLimit(ip, bucket, maxRequests, windowMs) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (rateLimitBuckets.get(key) || []).filter(t => t > cutoff);
  if (hits.length >= maxRequests) return false;
  hits.push(now);
  rateLimitBuckets.set(key, hits);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, hits] of rateLimitBuckets) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length === 0) rateLimitBuckets.delete(key);
    else rateLimitBuckets.set(key, fresh);
  }
}, 5 * 60 * 1000);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

// SHA-256 of the one inline <script> in index.html — the theme bootstrap that
// sets data-theme before first paint so the page doesn't flash the wrong colour.
// Naming it by hash is what lets script-src drop 'unsafe-inline'.
//
// If you edit that script, this hash must change with it or the page loads
// unthemed. The browser console prints the expected hash on violation; to
// compute it up front:
//   node -e 'const s=require("fs").readFileSync("index.html","utf8");
//     const b=s.slice(s.indexOf("<script>")+8, s.indexOf("</script>"));
//     console.log(require("crypto").createHash("sha256").update(b).digest("base64"))'
const INLINE_THEME_SCRIPT_HASH = "'sha256-PxYpOAntedsUntWSVSNJ8tkM00yECRo0ccasTNtMyaI='";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Nothing in the app needs these, and denying them means a compromised
  // dependency cannot quietly turn one on.
  "Permissions-Policy": "geolocation=(self), microphone=(self), camera=(), payment=(), usb=(self), interest-cohort=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    // No 'unsafe-inline': the only inline script is hashed above, and the last
    // inline event handler (SSTV's Load Image button) is now bound in JS. Keeping
    // 'unsafe-inline' here would have made the whole policy decorative against
    // the injected-script case it exists to stop.
    `script-src 'self' ${INLINE_THEME_SCRIPT_HASH} 'wasm-unsafe-eval' https://unpkg.com https://cdnjs.cloudflare.com`,
    // style-src still allows 'unsafe-inline': index.html carries ~50 style=""
    // attributes and Leaflet sets inline styles on every pane it positions.
    // Inline *styles* cannot execute script, so this is a much smaller exposure
    // than the script-src case — but it is the next thing to tighten.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com",
    // unpkg.com: Leaflet's default marker icons are referenced from leaflet.css,
    // so when the map falls back to the CDN (today's only path — vendor/leaflet/
    // is not in the repo) the icons load from there too. Without this the map
    // draws with invisible markers.
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
    // ws://localhost is the Hamlib rigctld bridge (js/connectors/cat.js's
    // DEFAULT_BRIDGE_URL, ws://localhost:8073). It was missing, so every one of
    // the three rigctld profiles failed to connect under this server's own CSP —
    // with only a console violation to show for it.
    [
      "connect-src 'self'",
      "https://api.pota.app https://api.sotl.as https://api.allorigins.win",
      "wss://mqtt.pskreporter.info:1886",
      "ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
    ].join(" "),
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ")
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      // Stop accumulating once over the cap. Rejecting alone left this handler
      // attached, so `raw` kept growing; destroying the socket instead would
      // replace the "payload too large" JSON with an ECONNRESET.
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > 512 * 1024) {
        tooLarge = true;
        raw = "";
        reject(new Error("Request payload is too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}


function firstText(value = "") {
  return String(value).trim();
}

function parseSimpleXmlTag(xmlText, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const match = xmlText.match(pattern);
  return firstText(match?.[1] || "");
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

// Imported dynamically for the same reason as tq8.js below: this file is
// CommonJS and the shared _lib modules are ESM.
let lotwQueryModule = null;
async function loadLotwQuery() {
  if (!lotwQueryModule) lotwQueryModule = await import("./functions/_lib/lotw-query.js");
  return lotwQueryModule;
}

async function handleLotwDownload(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  const login = firstText(body?.login);
  const password = firstText(body?.password);
  // The cursor from the previous report (APP_LoTW_LASTQSL); absent on a first
  // sync, which is the only case that pulls the whole log.
  const qslSince = firstText(body?.qslSince);
  if (!login || !password) {
    sendJson(res, 400, { error: "Missing LoTW credentials." });
    return;
  }

  const { buildLotwReportUrl, classifyLotwReport, isFullPull, parseLastQsl } = await loadLotwQuery();

  try {
    const response = await fetch(buildLotwReportUrl({ login, password, qslSince }));
    const adif = await response.text();
    if (!response.ok) {
      sendJson(res, 502, { error: `LoTW download failed (${response.status}).` });
      return;
    }
    const failure = classifyLotwReport(adif);
    if (failure) {
      sendJson(res, failure.status, { error: failure.error });
      return;
    }
    sendJson(res, 200, {
      message: "LoTW report downloaded",
      full: isFullPull(qslSince),
      lastQsl: parseLastQsl(adif),
      adif
    });
  } catch (error) {
    sendJson(res, 502, { error: `LoTW download error: ${error.message}` });
  }
}

// ── LoTW sign + upload ───────────────────────────────────────────────────────
//
// The signing itself lives in functions/_lib/tq8.js, shared with the Cloudflare
// Pages Function so the hosted build and this server emit the same bytes by
// construction. It needs no subprocess and no temp file, so the operator's
// private key never touches disk.
//
// No QSO cap is passed: unlike a Function invocation, this process has no CPU
// ceiling to run into.
//
// Imported dynamically because this file is CommonJS and tq8.js is ESM.
let tq8Module = null;
async function loadTq8() {
  if (!tq8Module) tq8Module = await import("./functions/_lib/tq8.js");
  return tq8Module;
}

async function handleLotwSignUpload(req, res) {
  let payload;
  try {
    payload = JSON.parse((await collectRequestBody(req)) || "{}");
  } catch {
    sendJson(res, 400, { error: "Body must be valid JSON." });
    return;
  }

  const login      = firstText(payload.login);
  const password   = firstText(payload.password);
  const p12Base64  = typeof payload.p12Base64 === "string" ? payload.p12Base64 : "";
  const p12Pass    = typeof payload.p12Pass   === "string" ? payload.p12Pass   : "";
  const adif       = typeof payload.adif      === "string" ? payload.adif      : "";
  const gridsquare = typeof payload.gridsquare === "string" ? payload.gridsquare.trim().toUpperCase() : "";

  if (!login || !password || !p12Base64 || !adif) {
    sendJson(res, 400, { error: "Missing required fields: login, password, p12Base64, adif." });
    return;
  }

  const { buildSignedTq8, uploadTq8 } = await loadTq8();

  let signed;
  try {
    signed = await buildSignedTq8({ p12Base64, p12Pass, adif, gridsquare, login });
  } catch (error) {
    // tq8.js throws only operator-safe messages (wrong certificate password,
    // unreadable file, empty log). Anything else is logged, not echoed — the
    // client renders this string into its activity log.
    const safe = /password is incorrect|not a readable|contains no|No valid QSO/i.test(error?.message || "");
    if (!safe) console.error("[lotw] signing failed:", error);
    sendJson(res, safe ? 400 : 500, {
      error: safe ? error.message : "Signing failed. Check the certificate and its password, then try again.",
    });
    return;
  }

  // Skips the upload, not the signing — see the note in the Pages Function. By
  // this line the certificate has been parsed and every QSO signed, so a dry run
  // exercises everything except contacting ARRL.
  if (LOTW_DRY_RUN) {
    sendJson(res, 200, {
      message:
        `[dry-run] Signed ${signed.qsoCount} QSOs into a ${(signed.tq8.length / 1024).toFixed(1)} KB .tq8. ` +
        `Upload skipped — LOTW_DRY_RUN=1 is set.`,
      qsoCount: signed.qsoCount,
      tq8Bytes: signed.tq8.length,
      dryRun: true,
    });
    return;
  }

  try {
    const result = await uploadTq8({ tq8: signed.tq8, login, password });
    sendJson(res, result.status, result.error ? { error: result.error } : { message: result.message });
  } catch (error) {
    sendJson(res, 502, { error: `LoTW upload error: ${error.message}` });
  }
}

async function fetchQrzSession(qrzUsername, qrzPassword) {
  const loginUrl = `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(qrzUsername)};password=${encodeURIComponent(
    qrzPassword
  )}`;
  const response = await fetch(loginUrl);
  const xmlText = await response.text();
  const sessionKey = parseSimpleXmlTag(xmlText, "Key");
  const errorText = parseSimpleXmlTag(xmlText, "Error");
  if (!sessionKey) {
    throw new Error(errorText || "QRZ login failed");
  }
  return sessionKey;
}

async function lookupWithQrz(callsign, credOverrides = {}) {
  const qrzUsername = credOverrides.qrzUser || process.env.QRZ_USERNAME;
  const qrzPassword = credOverrides.qrzPass || process.env.QRZ_PASSWORD;
  if (!qrzUsername || !qrzPassword) {
    return null;
  }
  const sessionKey = await fetchQrzSession(qrzUsername, qrzPassword);
  const lookupUrl = `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(sessionKey)};callsign=${encodeURIComponent(callsign)}`;
  const lookupResponse = await fetch(lookupUrl);
  const lookupXml = await lookupResponse.text();
  const errorText = parseSimpleXmlTag(lookupXml, "Error");
  if (errorText) {
    throw new Error(errorText);
  }
  const foundCallsign = parseSimpleXmlTag(lookupXml, "call");
  if (!foundCallsign) {
    return null;
  }
  const firstName = parseSimpleXmlTag(lookupXml, "fname");
  const lastName = parseSimpleXmlTag(lookupXml, "name");
  return {
    source: "QRZ",
    callsign: foundCallsign,
    operatorName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    qth: [parseSimpleXmlTag(lookupXml, "city"), parseSimpleXmlTag(lookupXml, "state")]
      .filter(Boolean)
      .join(", "),
    grid: parseSimpleXmlTag(lookupXml, "grid"),
    country: parseSimpleXmlTag(lookupXml, "country")
  };
}

async function fetchHamQthSession(username, password) {
  const sessionUrl = `https://www.hamqth.com/xml.php?u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`;
  const response = await fetch(sessionUrl);
  const xmlText = await response.text();
  const sessionId = parseSimpleXmlTag(xmlText, "session_id");
  const errorText = parseSimpleXmlTag(xmlText, "error");
  if (!sessionId) {
    throw new Error(errorText || "HamQTH login failed");
  }
  return sessionId;
}

async function lookupWithHamQth(callsign, credOverrides = {}) {
  const username = credOverrides.hamqthUser || process.env.HAMQTH_USERNAME;
  const password = credOverrides.hamqthPass || process.env.HAMQTH_PASSWORD;
  if (!username || !password) {
    return null;
  }
  const sessionId = await fetchHamQthSession(username, password);
  const lookupUrl = `https://www.hamqth.com/xml.php?id=${encodeURIComponent(sessionId)}&callsign=${encodeURIComponent(callsign)}&prg=webham`;
  const response = await fetch(lookupUrl);
  const xmlText = await response.text();
  const errorText = parseSimpleXmlTag(xmlText, "error");
  if (errorText) {
    throw new Error(errorText);
  }
  const foundCallsign = parseSimpleXmlTag(xmlText, "callsign");
  if (!foundCallsign) {
    return null;
  }
  return {
    source: "HamQTH",
    callsign: foundCallsign,
    operatorName: [parseSimpleXmlTag(xmlText, "adr_name"), parseSimpleXmlTag(xmlText, "nick")].filter(Boolean)[0] || "",
    qth: [parseSimpleXmlTag(xmlText, "qth"), parseSimpleXmlTag(xmlText, "district")]
      .filter(Boolean)
      .join(", "),
    grid: parseSimpleXmlTag(xmlText, "grid"),
    country: parseSimpleXmlTag(xmlText, "country")
  };
}

async function handleCallsignLookup(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  const callsign = firstText(body?.call).toUpperCase();
  if (!callsign) {
    sendJson(res, 400, { error: "Missing field: call" });
    return;
  }
  if (!/^[A-Z0-9/]{3,}$/.test(callsign)) {
    sendJson(res, 400, { error: "Callsign format is invalid." });
    return;
  }

  const credOverrides = {
    qrzUser: firstText(body?.qrzUser),
    qrzPass: firstText(body?.qrzPass),
    hamqthUser: firstText(body?.hamqthUser),
    hamqthPass: firstText(body?.hamqthPass)
  };

  try {
    const qrzResult = await lookupWithQrz(callsign, credOverrides);
    if (qrzResult) {
      sendJson(res, 200, { message: "Lookup complete", result: qrzResult });
      return;
    }
    const hamQthResult = await lookupWithHamQth(callsign, credOverrides);
    if (hamQthResult) {
      sendJson(res, 200, { message: "Lookup complete", result: hamQthResult });
      return;
    }
    sendJson(res, 503, {
      error:
        "Lookup credentials not configured or callsign not found. Set QRZ_USERNAME/QRZ_PASSWORD or HAMQTH_USERNAME/HAMQTH_PASSWORD."
    });
  } catch (error) {
    sendJson(res, 502, { error: `Lookup provider error: ${error.message}` });
  }
}

async function handleTleDownload(res) {
  try {
    const response = await fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle", {
      headers: { "User-Agent": "WebHam/1.0 (https://github.com/rfvx/WebHam; ham radio logger)" }
    });
    if (!response.ok) {
      sendJson(res, 502, { error: `TLE fetch failed (${response.status} ${response.statusText})` });
      return;
    }
    const text = await response.text();
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "max-age=3600"
    });
    res.end(text);
  } catch (error) {
    sendJson(res, 502, { error: `TLE fetch error: ${error.message}` });
  }
}

const server = http.createServer((req, res) => {
  // A malformed Host header makes `new URL` throw. Uncaught inside the request
  // listener that would take the whole process down, so fall back instead.
  // A malformed Host header OR a malformed request target makes `new URL` throw.
  // Uncaught inside the request listener that takes the whole process down, and
  // retrying with a good base does not help when it is req.url that is bad.
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    try {
      requestUrl = new URL(req.url, "http://localhost");
    } catch {
      sendJson(res, 400, { error: "Malformed request URL." });
      return;
    }
  }
  const ip = getClientIp(req);

  // Guard the credential-bearing API. Bodies are JSON.parse'd regardless of
  // Content-Type, so without this any website could send a preflight-free
  // `text/plain` no-cors POST and spend the operator's QRZ quota or drive LoTW
  // on their behalf. Responses were never readable cross-origin (no CORS
  // headers), but the side effects landed.
  //
  // Checking only `Origin === Host` is NOT enough: both are attacker-controlled,
  // so evil.com resolving to 127.0.0.1 sends a matching pair and sails through.
  // That is DNS rebinding, the classic attack on a loopback server, so the Host
  // itself has to be on an allowlist.
  if (requestUrl.pathname.startsWith("/api/")) {
    if (!isAllowedApiHost(req.headers.host)) {
      sendJson(res, 403, { error: "Unrecognised Host header for an API request." });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === req.headers.host;
      } catch { sameOrigin = false; }
      if (!sameOrigin) {
        sendJson(res, 403, { error: "Cross-origin API requests are not allowed." });
        return;
      }
    }
  }

  if (requestUrl.pathname === "/api/callsign" && req.method === "POST") {
    if (!checkRateLimit(ip, "callsign", 30, 60 * 1000)) {
      sendJson(res, 429, { error: "Too many callsign lookups. Try again in a minute." });
      return;
    }
    void handleCallsignLookup(req, res);
    return;
  }
  if (requestUrl.pathname === "/api/lotw/download" && req.method === "POST") {
    if (!checkRateLimit(ip, "lotw", 10, 15 * 60 * 1000)) {
      sendJson(res, 429, { error: "Too many LoTW requests. Try again in 15 minutes." });
      return;
    }
    void handleLotwDownload(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/lotw/sign-upload" && req.method === "POST") {
    if (!checkRateLimit(ip, "lotw", 10, 15 * 60 * 1000)) {
      sendJson(res, 429, { error: "Too many LoTW requests. Try again in 15 minutes." });
      return;
    }
    void handleLotwSignUpload(req, res);
    return;
  }
  if (requestUrl.pathname === "/api/tle" && req.method === "GET") {
    if (!checkRateLimit(ip, "tle", 5, 60 * 1000)) {
      sendJson(res, 429, { error: "Too many TLE requests. Try again in a minute." });
      return;
    }
    void handleTleDownload(res);
    return;
  }
  if (requestUrl.pathname === "/api/time" && req.method === "GET") {
    sendJson(res, 200, { serverMs: Date.now() });
    return;
  }
  const urlPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  // decodeURIComponent first: WHATWG URL collapses ".." segments but leaves
  // percent-encoding alone, so "%2e%2e%2f" arrives here intact and only becomes
  // ".." once decoded. Decoding before normalising is what makes the check below
  // see the same path the filesystem will.
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Bad request");
    return;
  }
  const safePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);
  // The containment check, rather than trusting the sanitising above to be
  // exhaustive. path.resolve settles any remaining traversal, and everything
  // served must sit under ROOT. Cheap, and it does not depend on reasoning about
  // how URL parsing and path.normalize differ across platforms.
  const resolved = path.resolve(filePath);
  if (resolved !== path.resolve(ROOT) && !resolved.startsWith(path.resolve(ROOT) + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Forbidden");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();

  if (!MIME_TYPES[ext]) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Not found");
    return;
  }

  // Block server-side files that happen to share an allowed extension
  const BLOCKED_NAMES = new Set(["server.js", "package.json", "package-lock.json"]);
  if (BLOCKED_NAMES.has(path.basename(filePath))) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Not found");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
        res.end("Not found");
        return;
      }

      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Server error");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext],
      "Cache-Control": "no-cache",
      ...SECURITY_HEADERS
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Web Ham Logger running at http://localhost:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn(`[warn] listening on ${HOST} — credential-bearing endpoints are reachable off-host. Use TLS.`);
  }
});
