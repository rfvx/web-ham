// POST /api/lotw/download — fetches the operator's confirmation report from
// ARRL Logbook of The World as ADIF (js/apps/logger/index.js). Proxied rather
// than fetched in-browser because lotw.arrl.org sends no CORS headers.
//
// LoTW credentials always come from the request body — they are the operator's
// ARRL login, which WebHam never stores server-side in any deployment.
import { json, readJsonBody, firstText } from "../../_lib/respond.js";
import { guard } from "../../_lib/guard.js";
import {
  buildLotwReportUrl,
  classifyLotwReport,
  isFullPull,
  parseLastQsl,
} from "../../_lib/lotw-query.js";

export async function onRequestPost({ request }) {
  const blocked = guard(request, {
    bucket: "lotw",
    max: 10,
    windowMs: 15 * 60 * 1000,
    tooManyMessage: "Too many LoTW requests. Try again in 15 minutes.",
  });
  if (blocked) return blocked;

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return json(400, { error: error.message });
  }

  const login = firstText(body?.login);
  const password = firstText(body?.password);
  // The cursor from the previous report (APP_LoTW_LASTQSL). Absent on a first
  // sync, which is the only case that pulls the whole log — see _lib/lotw-query.js.
  const qslSince = firstText(body?.qslSince);
  if (!login || !password) {
    return json(400, { error: "Missing LoTW credentials." });
  }

  try {
    const response = await fetch(buildLotwReportUrl({ login, password, qslSince }));
    const adif = await response.text();
    if (!response.ok) {
      return json(502, { error: `LoTW download failed (${response.status}).` });
    }
    // LoTW answers a bad login, and a tripped download limiter, with HTTP 200
    // and an explanation in the body — so the check has to read the payload.
    const failure = classifyLotwReport(adif);
    if (failure) {
      return json(failure.status, { error: failure.error });
    }
    return json(200, {
      message: "LoTW report downloaded",
      full: isFullPull(qslSince),
      // "" when the report carries no cursor; the client keeps its existing one
      // rather than falling back to a full pull next time.
      lastQsl: parseLastQsl(adif),
      adif,
    });
  } catch (error) {
    return json(502, { error: `LoTW download error: ${error.message}` });
  }
}
