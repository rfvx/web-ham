// Unit tests for the Cloudflare Pages Functions under functions/.
//
// These call the exported onRequest* handlers directly with a standard Request
// and assert on the returned Response. That works without wrangler because the
// handlers use only web-standard APIs (Request/Response/fetch/URL/TextEncoder),
// all of which Node 18+ provides natively — the same reason they run on
// Workers at all.
//
// Every case here is offline: each asserts a path that returns BEFORE any
// upstream fetch (validation, guards, the 501), so the suite never touches
// QRZ, ARRL, or celestrak. The credential-bearing success paths are not
// covered — they need live third-party logins.
import assert from "node:assert";
import { readFile } from "node:fs/promises";

import { onRequestGet as timeGet } from "../functions/api/time.js";
import { onRequestPost as callsignPost } from "../functions/api/callsign.js";
import { onRequestPost as lotwDownloadPost } from "../functions/api/lotw/download.js";
import { onRequestPost as signUploadPost } from "../functions/api/lotw/sign-upload.js";
import { onRequestGet as tleGet } from "../functions/api/tle.js";

const ORIGIN = "https://webham.example.pages.dev";

// Each test uses a distinct client IP so the module-level sliding-window
// limiter in functions/_lib/guard.js cannot leak state between cases.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function req(path, { method = "GET", body, origin, ip = nextIp() } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (origin !== undefined) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jsonOf(response) {
  return JSON.parse(await response.text());
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ── /api/time ────────────────────────────────────────────────────────────────

await check("time: returns a plausible serverMs", async () => {
  const before = Date.now();
  const res = await timeGet({ request: req("/api/time") });
  assert.strictEqual(res.status, 200);
  const payload = await jsonOf(res);
  assert.ok(
    payload.serverMs >= before && payload.serverMs <= Date.now(),
    `serverMs ${payload.serverMs} outside [${before}, now]`
  );
});

await check("time: sets the ported security headers", async () => {
  const res = await timeGet({ request: req("/api/time") });
  assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
  assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.strictEqual(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(res.headers.get("content-type"), /application\/json/);
});

await check("time: same-origin Origin is accepted", async () => {
  const res = await timeGet({ request: req("/api/time", { origin: ORIGIN }) });
  assert.strictEqual(res.status, 200);
});

await check("time: cross-origin Origin is rejected 403", async () => {
  const res = await timeGet({ request: req("/api/time", { origin: "https://evil.example" }) });
  assert.strictEqual(res.status, 403);
  assert.match((await jsonOf(res)).error, /Cross-origin/i);
});

// A missing Origin must stay allowed: same-origin GETs and non-browser clients
// omit it, and a browser cannot suppress it on a cross-origin POST.
await check("time: absent Origin is allowed", async () => {
  const res = await timeGet({ request: req("/api/time") });
  assert.strictEqual(res.status, 200);
});

// ── /api/callsign ────────────────────────────────────────────────────────────

await check("callsign: missing call -> 400", async () => {
  const res = await callsignPost({ request: req("/api/callsign", { method: "POST", body: {} }), env: {} });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /Missing field: call/);
});

await check("callsign: malformed call -> 400", async () => {
  const res = await callsignPost({
    request: req("/api/callsign", { method: "POST", body: { call: "a!" } }),
    env: {},
  });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /invalid/i);
});

await check("callsign: invalid JSON body -> 400", async () => {
  const request = new Request(`${ORIGIN}/api/callsign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
    body: "{not json",
  });
  const res = await callsignPost({ request, env: {} });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /valid JSON/i);
});

// No credentials in the body and no env fallback => 503 without any upstream
// call. This is the default hosted posture.
await check("callsign: no credentials -> 503, no upstream call", async () => {
  const res = await callsignPost({
    request: req("/api/callsign", { method: "POST", body: { call: "W1AW" } }),
    env: {},
  });
  assert.strictEqual(res.status, 503);
  assert.match((await jsonOf(res)).error, /No lookup credentials/i);
});

// The env fallback must stay inert unless explicitly enabled, so a public
// deployment cannot be used as an open proxy for the operator's QRZ quota.
// Without the opt-in these creds are ignored, so the handler still short-
// circuits at 503 rather than reaching QRZ.
await check("callsign: env creds ignored unless ALLOW_SERVER_CREDENTIALS=1", async () => {
  const res = await callsignPost({
    request: req("/api/callsign", { method: "POST", body: { call: "W1AW" } }),
    env: { QRZ_USERNAME: "someone", QRZ_PASSWORD: "secret" },
  });
  assert.strictEqual(res.status, 503, "env creds must not be consulted without the opt-in");
});

await check("callsign: cross-origin -> 403 before body parsing", async () => {
  const res = await callsignPost({
    request: req("/api/callsign", { method: "POST", body: { call: "W1AW" }, origin: "https://evil.example" }),
    env: {},
  });
  assert.strictEqual(res.status, 403);
});

await check("callsign: rate limit trips at 30/min for one IP", async () => {
  const ip = nextIp();
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await callsignPost({
      request: req("/api/callsign", { method: "POST", body: { call: "W1AW" }, ip }),
      env: {},
    });
  }
  assert.strictEqual(last.status, 429);
  assert.match((await jsonOf(last)).error, /Too many callsign lookups/);
});

await check("callsign: a different IP is unaffected by that limit", async () => {
  const res = await callsignPost({
    request: req("/api/callsign", { method: "POST", body: { call: "W1AW" } }),
    env: {},
  });
  assert.notStrictEqual(res.status, 429);
});

// ── /api/lotw/download ───────────────────────────────────────────────────────

await check("lotw/download: missing credentials -> 400", async () => {
  const res = await lotwDownloadPost({
    request: req("/api/lotw/download", { method: "POST", body: {} }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /Missing LoTW credentials/);
});

await check("lotw/download: cross-origin -> 403", async () => {
  const res = await lotwDownloadPost({
    request: req("/api/lotw/download", {
      method: "POST",
      body: { login: "x", password: "y" },
      origin: "https://evil.example",
    }),
  });
  assert.strictEqual(res.status, 403);
});

// The query itself — which parameters, and the abuse-detector handling — is
// covered in test/test-lotw-query.mjs. What these pin is the wiring: that the
// endpoint actually reaches for the shared builder with the caller's cursor,
// and hands the cursor from the report back. Both are easy to import and then
// quietly not use. `fetch` is stubbed, so the suite stays offline.
async function withStubbedFetch(reply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(reply, { status: 200 });
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const STUB_REPORT =
  "<PROGRAMID:4>LoTW\n<APP_LoTW_LASTQSL:19>2026-08-19 21:04:11\n<EOH>\n<CALL:4>W1AW<EOR>\n";

await check("lotw/download: a stored cursor becomes an incremental query", async () => {
  const { result, calls } = await withStubbedFetch(STUB_REPORT, () =>
    lotwDownloadPost({
      request: req("/api/lotw/download", {
        method: "POST",
        body: { login: "W1AW", password: "pw", qslSince: "2026-08-01 00:00:00" },
      }),
    })
  );
  assert.strictEqual(calls.length, 1);
  const params = new URL(calls[0]).searchParams;
  assert.strictEqual(params.get("qso_qslsince"), "2026-08-01 00:00:00");
  assert.strictEqual(params.get("qso_qsl"), "yes");

  const payload = await jsonOf(result);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(payload.full, false);
  assert.strictEqual(payload.lastQsl, "2026-08-19 21:04:11");
});

await check("lotw/download: no cursor -> full pull, flagged as such", async () => {
  const { result, calls } = await withStubbedFetch(STUB_REPORT, () =>
    lotwDownloadPost({
      request: req("/api/lotw/download", {
        method: "POST",
        body: { login: "W1AW", password: "pw" },
      }),
    })
  );
  assert.strictEqual(new URL(calls[0]).searchParams.get("qso_qsl"), "no");
  // The client reads `full` to decide whether a returned record means
  // "confirmed" or merely "LoTW has it"; getting it wrong silently marks an
  // entire log as confirmed.
  assert.strictEqual((await jsonOf(result)).full, true);
});

await check("lotw/download: the limiter's reply is reported, not parsed as empty", async () => {
  const { result } = await withStubbedFetch("Invalid Request", () =>
    lotwDownloadPost({
      request: req("/api/lotw/download", {
        method: "POST",
        body: { login: "W1AW", password: "pw", qslSince: "2026-08-01" },
      }),
    })
  );
  assert.strictEqual(result.status, 429);
});

// ── /api/lotw/sign-upload ────────────────────────────────────────────────────

// The signer itself is covered byte-for-byte in test/test-lotw-sign.mjs. What
// matters here is the endpoint around it: nothing reaches ARRL, and nothing
// reaches the signer, until the request has passed the guard and carries a
// complete payload.
await check("lotw/sign-upload: missing credentials -> 400, no upstream call", async () => {
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", { method: "POST", body: { adif: "<eor>" } }),
    env: {},
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.match((await jsonOf(res)).error, /Missing required fields/);
});

await check("lotw/sign-upload: cross-origin -> 403 before body parsing", async () => {
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", {
      method: "POST",
      body: { login: "n0call", password: "x", p12Base64: "x", adif: "<eor>" },
      origin: "https://evil.example",
    }),
    env: {},
  });
  assert.strictEqual(res.status, 403);
});

// LOTW_DRY_RUN skips the upload, NOT the signing — it has to run late enough to
// have exercised the certificate parse and the per-QSO signing, since those are
// what actually break on a fresh deployment. A dry run that answered before
// validating the payload would prove only that the route is reachable, so these
// two cases pin the ordering from both sides.
await check("lotw/sign-upload: LOTW_DRY_RUN=1 still validates the payload", async () => {
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", { method: "POST", body: {} }),
    env: { LOTW_DRY_RUN: "1" },
  });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /Missing required fields/);
});

await check("lotw/sign-upload: LOTW_DRY_RUN=1 still parses the certificate", async () => {
  const adif = "<eoh>\n<CALL:6>VK3ABC<BAND:3>20m<MODE:3>SSB<QSO_DATE:8>20240115<TIME_ON:6>123000<eor>\n";
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", {
      method: "POST",
      body: { login: "n0call", password: "x", p12Base64: "bm90IGEgY2VydA==", adif },
    }),
    env: { LOTW_DRY_RUN: "1" },
  });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /not a readable \.p12 certificate/);
});

// A log with nothing signable in it is rejected before the certificate is
// touched, so an empty export never asks for a password in vain.
await check("lotw/sign-upload: ADIF with no QSOs -> 400 naming the cause", async () => {
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", {
      method: "POST",
      body: { login: "n0call", password: "x", p12Base64: "bm90IGEgY2VydA==", adif: "<eoh>\n<eor>\n" },
    }),
    env: {},
  });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /No valid QSO records/);
});

// A garbage certificate must come back as the operator-facing message from
// tq8.js, not as a 500 with an internal stack detail in it.
await check("lotw/sign-upload: unreadable certificate -> 400 naming the cause", async () => {
  const adif =
    "<eoh>\n<CALL:6>VK3ABC<BAND:3>20m<MODE:3>SSB<QSO_DATE:8>20240115<TIME_ON:6>123000<eor>\n";
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", {
      method: "POST",
      body: { login: "n0call", password: "x", p12Base64: "bm90IGEgY2VydA==", adif },
    }),
    env: {},
  });
  assert.strictEqual(res.status, 400);
  assert.match((await jsonOf(res)).error, /not a readable \.p12 certificate/);
});

// Signing is one RSA operation per QSO against a serverless CPU ceiling, so an
// oversized log must be refused with an explanation before any signing starts —
// not killed part-way through, which reads to the operator as a silent failure.
await check("lotw/sign-upload: a log over the cap -> 400 naming the cap", async () => {
  let adif = "<eoh>\n";
  for (let i = 0; i < 4; i += 1) {
    adif += `<CALL:6>VK3A0${i}<BAND:3>20m<MODE:3>SSB<QSO_DATE:8>20240115<TIME_ON:6>12300${i}<eor>\n`;
  }
  const res = await signUploadPost({
    request: req("/api/lotw/sign-upload", {
      method: "POST",
      body: { login: "n0call", password: "x", p12Base64: "bm90IGEgY2VydA==", adif },
    }),
    env: { LOTW_MAX_QSOS: "3" },
  });
  assert.strictEqual(res.status, 400);
  const { error } = await jsonOf(res);
  assert.match(error, /4 QSOs/);
  assert.match(error, /signs at most 3/);
  // It must point at the way out, since the operator cannot raise the cap.
  assert.match(error, /smaller batches|run WebHam locally/);
});

// A malformed override must land on the built-in default, not on "no cap at
// all" — which is what an unvalidated parseInt gives you, since NaN > 0 is false
// and the guard then never fires. Proven with a log over the default rather than
// under it: a one-QSO log passes either way and would not tell them apart.
await check("lotw/sign-upload: garbage LOTW_MAX_QSOS falls back to the default cap", async () => {
  let adif = "<eoh>\n";
  for (let i = 0; i < 2001; i += 1) {
    adif += `<CALL:6>VK3A${String(i % 100).padStart(2, "0")}<BAND:3>20m<MODE:3>SSB` +
      `<QSO_DATE:8>20240115<TIME_ON:6>123000<eor>\n`;
  }
  for (const bad of [undefined, "", "0", "-5", "nonsense"]) {
    const res = await signUploadPost({
      request: req("/api/lotw/sign-upload", {
        method: "POST",
        body: { login: "n0call", password: "x", p12Base64: "bm90IGEgY2VydA==", adif },
      }),
      env: bad === undefined ? {} : { LOTW_MAX_QSOS: bad },
    });
    const label = `LOTW_MAX_QSOS=${JSON.stringify(bad)}`;
    assert.strictEqual(res.status, 400, label);
    assert.match((await jsonOf(res)).error, /signs at most 2000 at a time/, label);
  }
});

// Ten in fifteen minutes: signing is the most expensive thing either server
// does, and each attempt carries a private key.
await check("lotw/sign-upload: rate limit trips at 10 per window for one IP", async () => {
  const ip = nextIp();
  const post = () =>
    signUploadPost({
      request: req("/api/lotw/sign-upload", { method: "POST", body: {}, ip }),
      env: { LOTW_DRY_RUN: "1" },
    });
  // 400 (the empty payload) rather than 429 is what "allowed through" looks like
  // here; the point is that the limiter did not fire.
  for (let i = 0; i < 10; i += 1) {
    assert.strictEqual((await post()).status, 400, `request ${i + 1} should be allowed`);
  }
  const res = await post();
  assert.strictEqual(res.status, 429);
  assert.match((await jsonOf(res)).error, /15 minutes/);
});

await check("lotw/sign-upload: GET -> 405 JSON, not a static 404", async () => {
  const { onRequestGet } = await import("../functions/api/lotw/sign-upload.js");
  const res = await onRequestGet();
  assert.strictEqual(res.status, 405);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.match((await jsonOf(res)).error, /POST/);
});

// ── /api/[[path]] catch-all ──────────────────────────────────────────────────

// Guards against the fall-through that Pages does by default: an unmatched
// /api/* path is served index.html with HTTP 200, so a mistyped endpoint looks
// like a success and the client reports a JSON parse error against HTML.
await check("catch-all: unknown /api path -> 404 JSON naming the path", async () => {
  const { onRequest } = await import("../functions/api/[[path]].js");
  const res = await onRequest({ request: req("/api/definitely-not-a-route") });
  assert.strictEqual(res.status, 404);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.match((await jsonOf(res)).error, /No such API endpoint: \/api\/definitely-not-a-route/);
});

// ── /api/tle ─────────────────────────────────────────────────────────────────

await check("tle: cross-origin -> 403 before any upstream fetch", async () => {
  const res = await tleGet({ request: req("/api/tle", { origin: "https://evil.example" }) });
  assert.strictEqual(res.status, 403);
});

// Exercised against the limiter directly rather than through tleGet: the TLE
// handler fetches celestrak once the guard passes, and this suite stays offline.
// The 5/min budget wired into functions/api/tle.js is asserted separately below.
await check("tle: limiter allows exactly 5 in a 60s window, then refuses", async () => {
  const ip = nextIp();
  const { checkRateLimit } = await import("../functions/_lib/guard.js");
  const request = new Request(`${ORIGIN}/api/tle`, { headers: { "CF-Connecting-IP": ip } });
  let allowed = 0;
  for (let i = 0; i < 8; i += 1) {
    if (checkRateLimit(request, "tle", 5, 60 * 1000)) allowed += 1;
  }
  assert.strictEqual(allowed, 5, "limiter should allow exactly 5 in the window");
});

// Guards the budget itself, so loosening it in the handler is a test failure
// rather than a silent change in how hard WebHam leans on celestrak.
await check("tle: handler is wired to a 5/min budget", async () => {
  const source = await readFile(new URL("../functions/api/tle.js", import.meta.url), "utf8");
  assert.match(source, /bucket:\s*"tle"/);
  assert.match(source, /max:\s*5\b/);
  assert.match(source, /windowMs:\s*60\s*\*\s*1000/);
});

process.stdout.write(`\npages-functions: ${passed} assertions passed\n`);
