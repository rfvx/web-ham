// Abuse guards for the Pages Functions API: a same-origin check and a
// best-effort per-IP rate limiter.
//
// How this differs from server.js, deliberately:
//
// - server.js additionally gates /api/* on a Host ALLOWLIST. That guard exists
//   because it binds loopback by default and a loopback server is the classic
//   DNS-rebinding target: evil.com resolving to 127.0.0.1 supplies a matching
//   Origin/Host pair, so Origin === Host alone is not enough there. On Pages
//   there is no loopback and no rebinding position to attack — the request
//   arrives at Cloudflare's edge for the deployment's real hostname over TLS —
//   so the allowlist has nothing left to protect and is dropped rather than
//   carried over as a config knob that would reject every legitimate
//   *.pages.dev preview URL.
//
// - The Origin === own-origin check IS kept, and matters just as much here: the
//   endpoints JSON.parse bodies regardless of Content-Type, so without it any
//   site could fire a preflight-free `text/plain` no-cors POST and drive LoTW
//   or spend a QRZ quota on the operator's behalf. Responses are not readable
//   cross-origin (no CORS headers are ever set), but the side effects land.
import { json } from "./respond.js";

// Rejects a cross-origin API request. Returns a Response to short-circuit
// with, or null when the request is acceptable.
//
// A missing Origin is allowed, matching server.js: same-origin GETs (and
// non-browser clients like curl) legitimately omit it, and a browser attacker
// cannot suppress Origin on a cross-origin POST.
export function checkSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  let ok = false;
  try {
    ok = new URL(origin).origin === new URL(request.url).origin;
  } catch {
    ok = false;
  }
  return ok ? null : json(403, { error: "Cross-origin API requests are not allowed." });
}

// Sliding-window limiter, same shape as server.js's checkRateLimit.
//
// IMPORTANT — this is BEST EFFORT on Pages and weaker than the Node version.
// Workers isolates are per-colocation and short-lived, so this Map is not a
// global counter: a client routed through several colos, or hitting a cold
// isolate, gets a fresh window. It raises the cost of casual hammering and
// nothing more. For a real limit, bind Cloudflare's native Rate Limiting
// binding (or a Durable Object) — see README. Left in as defence-in-depth
// because the endpoints reach third-party APIs (QRZ, ARRL, celestrak) that do
// enforce their own quotas, and a partial brake beats none.
const rateLimitBuckets = new Map();

function clientIp(request) {
  // CF-Connecting-IP is set by Cloudflare's edge and, unlike X-Forwarded-For
  // on a bare Node server, cannot be spoofed by the client — it is overwritten
  // at ingress. So there is no TRUST_PROXY equivalent to gate here.
  return request.headers.get("cf-connecting-ip") || "unknown";
}

export function checkRateLimit(request, bucket, maxRequests, windowMs) {
  const key = `${bucket}:${clientIp(request)}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (rateLimitBuckets.get(key) || []).filter((t) => t > cutoff);
  if (hits.length >= maxRequests) return false;
  hits.push(now);
  rateLimitBuckets.set(key, hits);
  // Opportunistic sweep: server.js runs a setInterval for this, which a Worker
  // cannot do (no timers outside a request). Bounding the map here keeps a
  // long-lived isolate from accumulating keys indefinitely.
  if (rateLimitBuckets.size > 5000) {
    for (const [k, v] of rateLimitBuckets) {
      if (v.every((t) => t <= cutoff)) rateLimitBuckets.delete(k);
    }
  }
  return true;
}

// One wrapper so each endpoint states its own limits and stays a one-liner.
export function guard(request, { bucket, max, windowMs, tooManyMessage }) {
  const crossOrigin = checkSameOrigin(request);
  if (crossOrigin) return crossOrigin;
  if (bucket && !checkRateLimit(request, bucket, max, windowMs)) {
    return json(429, { error: tooManyMessage });
  }
  return null;
}

// Server-side credential fallback is OPT-IN on Pages, unlike server.js where
// QRZ_USERNAME/QRZ_PASSWORD etc. are always consulted.
//
// The reason: server.js is a loopback, single-operator process, so "fall back
// to the station's own env credentials" is safe there. A Pages deployment is
// public by default — the same fallback would turn /api/callsign into an open
// proxy that spends the operator's QRZ quota for anyone who finds the URL.
// The browser already sends the operator's own credentials from its encrypted
// local store (see js/connectors/lookup.js and js/connectors/secure-store.js),
// so the fallback is not needed for normal use.
//
// Set ALLOW_SERVER_CREDENTIALS=1 (plus the credential vars) only on a
// deployment you have restricted to yourself, e.g. behind Cloudflare Access.
export function serverCredentialsAllowed(env) {
  return env?.ALLOW_SERVER_CREDENTIALS === "1";
}
