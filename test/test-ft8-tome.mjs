// Self-check for the "responding to you" highlight rule in renderFt8TextDecodes:
// standard FT8 is "TO FROM payload", so a decode whose TO field is our own call
// is a station calling us. Run: node test-ft8-tome.mjs
import assert from "node:assert";

const norm = (v) => v.trim().toUpperCase();
function isToMe(text, myCall) {
  const tokens = (text || "").split(/\s+/);
  const isCq = /\bCQ\b/i.test(text);
  const toField = norm((tokens[0] || "").replace(/[<>]/g, ""));
  return !!norm(myCall) && !isCq && toField === norm(myCall);
}

assert.equal(isToMe("K1ABC EA7XYZ -12", "K1ABC"), true);   // answering us
assert.equal(isToMe("K1ABC EA7XYZ RR73", "K1ABC"), true);  // rogering us
assert.equal(isToMe("<K1ABC> EA7XYZ +03", "K1ABC"), true); // hashed TO field
assert.equal(isToMe("k1abc ea7xyz r-09", "K1ABC"), true);  // case-insensitive
assert.equal(isToMe("CQ K1ABC FN42", "K1ABC"), false);     // we are the caller, not the target
assert.equal(isToMe("EA7XYZ K1ABC -12", "K1ABC"), false);  // we are FROM (our own tx)
assert.equal(isToMe("CQ EA7XYZ IM76", "K1ABC"), false);    // unrelated CQ
assert.equal(isToMe("W1AW EA7XYZ -05", "K1ABC"), false);   // directed at someone else
assert.equal(isToMe("K1ABC EA7XYZ -12", ""), false);       // no call configured

// "New grid" field extraction — must skip RR73/RRR/73 (they match the grid regex).
function findGridField(text) {
  const tokens = norm(text || "").replace(/\s+/g, " ").trim().split(" ");
  for (const t of tokens) {
    if (t === "RR73" || t === "RRR" || t === "73") continue;
    if (/^[A-R]{2}\d{2}([A-X]{2})?$/.test(t)) return t.slice(0, 4);
  }
  return "";
}

assert.equal(findGridField("CQ K1ABC FN42"), "FN42");      // CQ with grid
assert.equal(findGridField("K1ABC EA7XYZ IM76GA"), "IM76"); // 6-char → field
assert.equal(findGridField("K1ABC EA7XYZ RR73"), "");       // roger, not a grid
assert.equal(findGridField("K1ABC EA7XYZ 73"), "");         // signoff
assert.equal(findGridField("K1ABC EA7XYZ -12"), "");        // report, not a grid
assert.equal(findGridField("CQ DX EA7XYZ IM76"), "IM76");   // directed CQ + grid

// Reply-button stage advance: clicking a station that answered you must pick the
// message that advances the QSO, not re-send your grid. Mirrors FT8_STAGE_REPLY +
// the CQ/unknown fallback in handleFt8DecodeAction (app.js).
const FT8_STAGE_REPLY = {
  "Grid copied": "report",
  "Report copied": "r-report",
  "R-report copied": "rrr",
  "RRR copied": "73",
  "RR73 copied": "73",
};
const replyAction = (stage, skipTx1) =>
  FT8_STAGE_REPLY[stage] || (skipTx1 ? "report" : "reply");

assert.equal(replyAction("Grid copied", false), "report");      // they sent grid → our report
assert.equal(replyAction("Report copied", false), "r-report");  // they sent report → R+report
assert.equal(replyAction("R-report copied", false), "rrr");     // they R+reported → RR73
assert.equal(replyAction("RR73 copied", false), "73");          // they confirmed → 73
assert.equal(replyAction("RRR copied", false), "73");           // RRR confirm → 73
assert.equal(replyAction("CQ copied", false), "reply");         // a CQ → grid reply
assert.equal(replyAction("CQ copied", true), "report");         // Skip Tx1 → report straight away
assert.equal(replyAction(undefined, false), "reply");           // unparseable → grid reply

console.log("ft8 to-me + new-grid + reply-stage advance: all assertions passed");
