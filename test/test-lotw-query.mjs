// functions/_lib/lotw-query.js — the LoTW report query both servers send.
//
// The rules under test are the ones that keep WebHam clear of LoTW's download
// abuse detector (docs/lotw-rate-limits.md). They are cheap to get wrong in a
// way nothing else notices: a query that asks for the whole log every time
// still returns a valid report, and a limiter response still parses as an
// empty one, so neither failure shows up as an error anywhere else.
import assert from "node:assert/strict";
import {
  buildLotwReportUrl,
  classifyLotwReport,
  isFullPull,
  parseLastQsl,
} from "../functions/_lib/lotw-query.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const CREDS = { login: "W1AW", password: "hunter2" };
const params = (url) => new URL(url).searchParams;

console.log("lotw-query: building the report query");

check("with a cursor, asks only for confirmations since it", () => {
  const p = params(buildLotwReportUrl({ ...CREDS, qslSince: "2026-08-01 12:00:00" }));
  assert.equal(p.get("qso_qsl"), "yes", "an incremental sync wants QSL records only");
  assert.equal(p.get("qso_qslsince"), "2026-08-01 12:00:00");
  assert.equal(p.get("qso_startdate"), null, "a date floor would undo the cursor");
});

check("without a cursor, falls back to the full bootstrap pull", () => {
  const p = params(buildLotwReportUrl({ ...CREDS, qslSince: "" }));
  assert.equal(p.get("qso_qsl"), "no", "the bootstrap needs every QSO, not just confirmed ones");
  assert.equal(p.get("qso_startdate"), "1945-11-15");
  assert.equal(p.get("qso_qslsince"), null);
});

check("omitting qslSince entirely is the same as an empty one", () => {
  assert.equal(buildLotwReportUrl(CREDS), buildLotwReportUrl({ ...CREDS, qslSince: "" }));
});

check("always asks for QSL detail and carries the credentials", () => {
  for (const qslSince of ["", "2026-08-01"]) {
    const p = params(buildLotwReportUrl({ ...CREDS, qslSince }));
    assert.equal(p.get("qso_qsldetail"), "yes", "QSL_RCVD has to be in the record");
    assert.equal(p.get("qso_query"), "1", "without qso_query the report has no QSO records at all");
    assert.equal(p.get("login"), "W1AW");
    assert.equal(p.get("password"), "hunter2");
  }
});

check("credentials are encoded, not interpolated", () => {
  const url = buildLotwReportUrl({ login: "W1AW", password: "a&b=c d" });
  assert.equal(params(url).get("password"), "a&b=c d", "round-trips through URLSearchParams");
  assert.ok(!url.includes("a&b=c d"), "the raw & would otherwise start a new parameter");
});

check("targets the report endpoint", () => {
  assert.equal(new URL(buildLotwReportUrl(CREDS)).origin + new URL(buildLotwReportUrl(CREDS)).pathname,
    "https://lotw.arrl.org/lotwuser/lotwreport.adi");
});

check("isFullPull marks exactly the cursor-less case", () => {
  assert.equal(isFullPull(""), true);
  assert.equal(isFullPull(undefined), true);
  assert.equal(isFullPull("2026-08-01"), false);
});

console.log("lotw-query: reading the response");

const REPORT_HEADER =
  "ARRL Logbook of the World Status Report\n" +
  "<PROGRAMID:4>LoTW\n" +
  "<APP_LoTW_LASTQSL:19>2026-08-19 21:04:11\n" +
  "<APP_LoTW_NUMREC:1>2\n" +
  "<EOH>\n";

check("a real report is not classified as a failure", () => {
  assert.equal(classifyLotwReport(REPORT_HEADER + "<CALL:4>W1AW<EOR>\n"), null);
});

check("an empty but well-formed report is not a failure", () => {
  assert.equal(classifyLotwReport(REPORT_HEADER), null, "no new confirmations is a valid answer");
});

check("bad credentials are 401, across LoTW's wordings", () => {
  for (const body of [
    "<html>Username/password incorrect</html>",
    "Your password is incorrect",
    "login failed",
    "unknown user",
  ]) {
    assert.equal(classifyLotwReport(body).status, 401, body);
  }
});

check("the download limiter is 429, not a server error", () => {
  // LoTW serves this with HTTP 200. Reporting it as 502 would blame the sync
  // path; reporting it as 429 tells the operator the truth — wait, then retry.
  const failure = classifyLotwReport("Invalid Request");
  assert.equal(failure.status, 429);
  assert.match(failure.error, /wait/i, "the message has to name the remedy");
});

check("a response with no ADIF header is a failure, not an empty log", () => {
  // Maintenance pages and login redirects parse to zero records. Treating that
  // as "synced, nothing new" is how a broken sync stays invisible for weeks.
  const failure = classifyLotwReport("<html><body>LoTW is offline for maintenance</body></html>");
  assert.equal(failure.status, 502);
});

check("classify tolerates an absent body", () => {
  assert.equal(classifyLotwReport(undefined).status, 502);
  assert.equal(classifyLotwReport("").status, 502);
});

console.log("lotw-query: the incremental cursor");

check("reads APP_LoTW_LASTQSL out of the header", () => {
  assert.equal(parseLastQsl(REPORT_HEADER), "2026-08-19 21:04:11");
});

check("honours the ADIF length prefix", () => {
  // ADIF fields are length-prefixed, not delimited. Reading to the next "<"
  // would work here only by accident of the trailing newline.
  assert.equal(parseLastQsl("<APP_LoTW_LASTQSL:10>2026-08-19 21:04:11\n<EOH>"), "2026-08-19");
});

check("accepts the type-suffixed form", () => {
  assert.equal(parseLastQsl("<APP_LoTW_LASTQSL:10:D>2026-08-19\n<EOH>"), "2026-08-19");
});

check("ignores a cursor-shaped field in the record body", () => {
  // Only the header carries the real cursor; a QSO record's fields must not be
  // able to rewind or advance it. Checked from both sides: a header cursor wins
  // over a body one, and a body one alone counts for nothing — searching the
  // whole document would pass the first case on ordering alone.
  const withHeader = REPORT_HEADER + "<CALL:4>W1AW<APP_LoTW_LASTQSL:10>1999-01-01<EOR>\n";
  assert.equal(parseLastQsl(withHeader), "2026-08-19 21:04:11");

  const bodyOnly = "<PROGRAMID:4>LoTW\n<EOH>\n<CALL:4>W1AW<APP_LoTW_LASTQSL:10>1999-01-01<EOR>\n";
  assert.equal(parseLastQsl(bodyOnly), "", "a record field is not a cursor");
});

check("returns empty when the report carries no cursor", () => {
  // The caller keeps its existing cursor on "" — returning anything truthy here
  // would corrupt it, and returning the whole header would be worse.
  assert.equal(parseLastQsl("<PROGRAMID:4>LoTW\n<EOH>\n<CALL:4>W1AW<EOR>"), "");
  assert.equal(parseLastQsl(""), "");
});

console.log(failures === 0 ? "\nlotw-query: all checks passed" : `\nlotw-query: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
