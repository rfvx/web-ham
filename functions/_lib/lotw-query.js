// Building and reading ARRL LoTW report queries.
//
// Shared by the Pages Function (functions/api/lotw/download.js) and the local
// server (server.js) so the hosted build and the local server send ARRL the
// same query by construction rather than by agreement — the same reason
// functions/_lib/tq8.js is shared.
//
// Why this file exists at all, rather than the two-line URLSearchParams both
// handlers used to carry: LoTW runs a download abuse detector, added because
// applications were re-downloading a user's whole log on every login. It
// answers a request that trips it with an "Invalid Request" body — not an HTTP
// error — so an application that ignores the body reports "synced, 0 matched"
// and the operator never learns why confirmations stopped arriving. The two
// rules that keep WebHam on the right side of it are encoded here:
//
//   1. Ask for confirmations, not for the whole log. `qso_qsl=yes` returns only
//      QSL records; a full `qso_qsl=no` pull is the bootstrap case only.
//   2. Ask incrementally. Every report carries an APP_LoTW_LASTQSL header
//      field; feeding it back as `qso_qslsince` on the next query is what makes
//      a sync cost one row per new confirmation instead of one per QSO ever
//      logged.
//
// See docs/lotw-rate-limits.md for the sourcing behind both.

const REPORT_URL = "https://lotw.arrl.org/lotwuser/lotwreport.adi";

// LoTW's own records start in 1945; there is no earlier QSO to miss.
const EPOCH = "1945-11-15";

// Builds the report query.
//
// `qslSince` is an APP_LoTW_LASTQSL value from a previous report ("YYYY-MM-DD"
// or "YYYY-MM-DD HH:MM:SS"). With it the query asks only for confirmations
// recorded since then. Without it — a first sync, or a logbook restored onto a
// fresh browser — the query falls back to the full pull that establishes which
// QSOs LoTW already holds, which is the one case where downloading everything
// is the point rather than the abuse.
export function buildLotwReportUrl({ login, password, qslSince = "" }) {
  const params = new URLSearchParams({
    login,
    password,
    qso_query: "1",
    // Include the QSL detail fields (QSL_RCVD and friends) rather than the bare
    // QSO columns, so a confirmation can be recognised from the record itself.
    qso_qsldetail: "yes",
  });

  if (qslSince) {
    params.set("qso_qsl", "yes");
    params.set("qso_qslsince", qslSince);
  } else {
    params.set("qso_qsl", "no");
    params.set("qso_startdate", EPOCH);
  }

  return `${REPORT_URL}?${params.toString()}`;
}

// True when this query is the full first-sync pull rather than an incremental
// one. Callers use it to label the report and to decide how loudly to rate-limit.
export function isFullPull(qslSince) {
  return !qslSince;
}

// LoTW reports failures in the body with HTTP 200, so status alone says
// nothing. Returns null when the body looks like a real report, or
// `{ status, error }` describing the failure.
export function classifyLotwReport(adif) {
  const text = String(adif || "");

  // LoTW's wording for a rejected login has varied ("password is incorrect",
  // "Username/password incorrect"), so match the shape rather than one phrase.
  if (/(password|username|user name).{0,20}incorrect|login failed|unknown user/i.test(text)) {
    return { status: 401, error: "LoTW rejected the provided credentials." };
  }

  // The abuse detector's reply. Reported as 429 rather than 502 because it is a
  // rate limit and the operator's own next action (wait, then sync again) is
  // what clears it — nothing is broken.
  if (/invalid request/i.test(text)) {
    return {
      status: 429,
      error:
        "LoTW declined the request — its download limiter is active for this " +
        "account. Wait a few minutes before syncing again.",
    };
  }

  // A report always carries an ADIF header. Anything else is LoTW serving a
  // page (maintenance, a redirect to the login form) that would otherwise parse
  // as zero records and read as "no new confirmations".
  if (!/<eoh>/i.test(text)) {
    return { status: 502, error: "LoTW returned an unexpected response instead of a report." };
  }

  return null;
}

// The cursor for the next incremental query. LoTW puts it in the ADIF header as
// APP_LoTW_LASTQSL; returns "" when absent (an empty report may omit it, in
// which case the caller keeps the cursor it already had).
export function parseLastQsl(adif) {
  const text = String(adif || "");
  const header = text.split(/<eoh>/i)[0] || "";
  const match = /<APP_LoTW_LASTQSL:(\d+)(?::[^>]*)?>([^<]*)/i.exec(header);
  if (!match) return "";
  return match[2].substring(0, Number.parseInt(match[1], 10)).trim();
}
