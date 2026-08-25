// POST /api/lotw/sign-upload — sign a log with the operator's LoTW certificate
// and upload it to ARRL, so the operator does not need TrustedQSL installed.
//
// The signing itself is functions/_lib/tq8.js, which server.js imports too — the
// hosted build and the local server produce the same bytes by construction
// rather than by agreement. This file is only the endpoint around it: the guard,
// the payload check, the QSO cap, and the rule that nothing but an
// operator-actionable message is ever echoed back.
import { json, readJsonBody, firstText } from "../../_lib/respond.js";
import { guard } from "../../_lib/guard.js";
import { buildSignedTq8, uploadTq8 } from "../../_lib/tq8.js";

// One RSA signature per QSO, ~0.6 ms each on the Workers runtime, so this is
// about 1.2 s of CPU at the cap. A serverless invocation has a CPU ceiling that
// depends on the plan; refusing an oversized log with an explanation beats
// having the request killed halfway through signing, which would look to the
// operator like the upload silently failed. Raise it with LOTW_MAX_QSOS on a
// plan that allows more. The local server applies no cap.
const DEFAULT_MAX_QSOS = 2000;

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, {
    bucket: "lotw",
    max: 10,
    windowMs: 15 * 60 * 1000,
    tooManyMessage: "Too many LoTW requests. Try again in 15 minutes.",
  });
  if (blocked) return blocked;

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    return json(400, { error: error.message });
  }

  const login = firstText(payload.login);
  const password = firstText(payload.password);
  const p12Base64 = typeof payload.p12Base64 === "string" ? payload.p12Base64 : "";
  const p12Pass = typeof payload.p12Pass === "string" ? payload.p12Pass : "";
  const adif = typeof payload.adif === "string" ? payload.adif : "";
  const gridsquare = typeof payload.gridsquare === "string" ? payload.gridsquare.trim().toUpperCase() : "";

  if (!login || !password || !p12Base64 || !adif) {
    return json(400, { error: "Missing required fields: login, password, p12Base64, adif." });
  }

  const parsedMax = Number.parseInt(env?.LOTW_MAX_QSOS ?? "", 10);
  const maxQsos = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_QSOS;

  let signed;
  try {
    signed = await buildSignedTq8({ p12Base64, p12Pass, adif, gridsquare, login, maxQsos });
  } catch (error) {
    // tq8.js throws only messages that are safe to show an operator (a wrong
    // certificate password, an unreadable file, an empty log, a log over the
    // cap). Anything else is logged and generalised rather than echoed — the
    // client renders this string.
    const safe = /password is incorrect|not a readable|contains no|No valid QSO|signs at most/i.test(
      error?.message || ""
    );
    if (!safe) console.error("[lotw] signing failed:", error);
    return json(safe ? 400 : 500, {
      error: safe
        ? error.message
        : "Signing failed. Check the certificate and its password, then try again.",
    });
  }

  // Skips the upload, not the signing. Placed here on purpose: everything that
  // can actually go wrong on a fresh deployment — the forge bundle loading, the
  // PKCS#12 parse, WebCrypto signing under the runtime's CPU limit, the QSO cap
  // — has already happened by this line. A dry run that returned earlier would
  // prove only that the route is reachable.
  if (env?.LOTW_DRY_RUN === "1") {
    return json(200, {
      message:
        `[dry-run] Signed ${signed.qsoCount} QSOs into a ${(signed.tq8.length / 1024).toFixed(1)} KB .tq8. ` +
        `Upload skipped — LOTW_DRY_RUN=1 is set.`,
      qsoCount: signed.qsoCount,
      tq8Bytes: signed.tq8.length,
      dryRun: true,
    });
  }

  try {
    const result = await uploadTq8({ tq8: signed.tq8, login, password });
    return json(result.status, result.error ? { error: result.error } : { message: result.message });
  } catch (error) {
    return json(502, { error: `LoTW upload error: ${error.message}` });
  }
}

// A GET explains itself rather than falling through to the static 404 page.
export function onRequestGet() {
  return json(405, { error: "POST a signed-upload payload to this endpoint." });
}
