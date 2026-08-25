// The pure-JS LoTW signer must produce exactly what the openssl implementation
// produced. Run: node test/test-lotw-sign.mjs
//
// ARRL accepting the upload is the only test that finally matters, and it cannot
// be run here. The next best thing is equivalence with the path that was already
// accepted in production: this builds a station certificate with the same shape
// ARRL issues (legacy PBE, the DXCC private extension), signs a log with BOTH
// implementations, and compares the emitted GABBI byte for byte.
//
// Skipped with a clear message when the `openssl` CLI is absent — there is then
// nothing to compare against, and a silent pass would be worse than a skip.
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAdifQsos, readStationCertificate, buildGabbi, buildSignedTq8, gzip,
} from "../functions/_lib/tq8.js";

const execFileAsync = promisify(execFile);
let passed = 0;
const check = async (label, fn) => { await fn(); passed += 1; process.stdout.write(`  ok  ${label}\n`); };

try {
  await execFileAsync("openssl", ["version"]);
} catch {
  process.stdout.write("SKIP test-lotw-sign: the openssl CLI is not available to compare against.\n");
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "webham-lotw-test-"));
const P12_PASS = "certpass123";

// ── a certificate shaped like ARRL's ────────────────────────────────────────
// DER:02:02:01:07 is INTEGER 263 — the DXCC entity, in the private extension
// LoTW uses (1.3.6.1.4.1.12348.1.4).
await writeFile(join(dir, "ext.cnf"), [
  "[req]", "distinguished_name=dn", "[dn]", "[v3]",
  "basicConstraints=CA:FALSE",
  "1.3.6.1.4.1.12348.1.4=DER:02:02:01:07",
].join("\n"));

await execFileAsync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
  "-days", "365", "-nodes", "-subj", "/CN=W1AW", "-extensions", "v3", "-config", join(dir, "ext.cnf"),
]);
// -legacy is the PBE ARRL actually ships (pbeWithSHA1And40BitRC2-CBC) and the
// reason the old implementation needed openssl at all.
await execFileAsync("openssl", [
  "pkcs12", "-export", "-legacy", "-inkey", join(dir, "k.pem"), "-in", join(dir, "c.pem"),
  "-out", join(dir, "test.p12"), "-passout", `pass:${P12_PASS}`, "-name", "W1AW",
]);

const p12Base64 = (await readFile(join(dir, "test.p12"))).toString("base64");
const privateKeyPem = await readFile(join(dir, "k.pem"), "utf8");

const ADIF = [
  "WebHam test export<EOH>",
  "<CALL:5>W2XYZ<QSO_DATE:8>20260819<TIME_ON:6>141500<BAND:3>20M<MODE:3>SSB<FREQ:6>14.250<STATION_CALLSIGN:4>W1AW<EOR>",
  "<CALL:6>DL1ABC<QSO_DATE:8>20260819<TIME_ON:4>1520<BAND:3>40M<MODE:2>CW<FREQ:5>7.030<STATION_CALLSIGN:4>W1AW<EOR>",
  // Exercises the /QRP strip and band-from-frequency inference.
  "<CALL:10>VK3DEF/QRP<QSO_DATE:8>20260819<TIME_ON:6>160000<MODE:3>FT8<FREQ:6>21.074<STATION_CALLSIGN:4>W1AW<EOR>",
  // Lowercase fields, which a sloppy ADIF export really does produce. This is what
  // makes the SIGNDATA uppercasing observable: with an all-uppercase fixture,
  // removing that step changes nothing and the equivalence test cannot see it.
  "<CALL:6>ja1xyz<QSO_DATE:8>20260819<TIME_ON:6>180000<BAND:3>80m<MODE:3>ssb<FREQ:5>3.790<STATION_CALLSIGN:4>W1AW<EOR>",
  // Missing MODE — must be dropped, as LoTW requires it.
  "<CALL:5>N0ONE<QSO_DATE:8>20260819<TIME_ON:6>170000<BAND:3>10M<EOR>",
].join("\n");

const GRID = "FN31PR";
const LOGIN = "w1aw";

// ── the reference implementation, reproduced from the openssl version ───────
// This is the code server.js ran before the port, with openssl doing the key
// extraction and crypto.createSign doing the signature.
const TQ8_STATION_SIG_FIELDS = [
  "AU_STATE", "CA_PROVINCE", "CA_US_PARK", "CN_PROVINCE", "CQZ", "DX_US_PARK",
  "FI_KUNTA", "GRIDSQUARE", "IOTA", "ITUZ", "JA_CITY_GUN_KU", "JA_PREFECTURE",
  "RU_OBLAST", "US_COUNTY", "US_PARK", "US_STATE",
];
const TQ8_QSO_SIG_FIELDS = [
  "BAND", "BAND_RX", "CALL", "FREQ", "FREQ_RX", "MODE", "PROP_MODE",
  "QSO_DATE", "QSO_TIME", "SAT_NAME",
];
const adifMakeField = (name, value, type) => {
  const v = String(value);
  return type ? `<${name}:${v.length}:${type}>${v}` : `<${name}:${v.length}>${v}`;
};
const lotwCall = (c) => c.toUpperCase().replace(/\/Q[A-Z0-9]+$/, "");
const tqslDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const tqslTime = (t) => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;

async function opensslReference(qsos, { forceDxcc = null } = {}) {
  const { createSign } = await import("node:crypto");
  // Key + leaf cert via the CLI, exactly as the old handler did.
  await execFileAsync("openssl", ["pkcs12", "-in", join(dir, "test.p12"), "-nocerts", "-nodes",
    "-passin", `pass:${P12_PASS}`, "-out", join(dir, "key.pem"), "-legacy"]);
  await execFileAsync("openssl", ["pkcs12", "-in", join(dir, "test.p12"), "-nokeys", "-clcerts",
    "-passin", `pass:${P12_PASS}`, "-out", join(dir, "cert.pem"), "-legacy"]);
  const keyPem = await readFile(join(dir, "key.pem"), "utf8");
  const certPem = await readFile(join(dir, "cert.pem"), "utf8");
  const certB64 = `${certPem.split("\n").filter((l) => /^[A-Za-z0-9+/]+=*$/.test(l.trim())).join("\n")}\n`;

  const { stdout: certText } = await execFileAsync("openssl", ["x509", "-in", join(dir, "cert.pem"), "-text", "-noout"]);
  // The regex the old implementation used. Kept verbatim so the test can show it
  // never matched; `forceDxcc` supplies the value the new path reads properly.
  const grepped = certText.match(/1\.3\.6\.1\.4\.1\.12348\.1\.4:\s*\n\s*(\d+)/)?.[1]?.trim() ?? "";
  const dxcc = forceDxcc ?? grepped;

  const stationLoc = { GRIDSQUARE: GRID };
  const callsign = (qsos[0].STATION_CALLSIGN || LOGIN).trim().toUpperCase();

  let gabbi = `${adifMakeField("TQSL_IDENT", "WebHam Lib: V2.8.6 Config: V11.34 AllowDupes: false")}\n\n`;
  gabbi += "<Rec_Type:5>tCERT\n";
  gabbi += `${adifMakeField("CERT_UID", "1")}\n`;
  gabbi += adifMakeField("CERTIFICATE", certB64);
  gabbi += "<eor>\n\n";
  gabbi += "<Rec_Type:8>tSTATION\n";
  gabbi += `${adifMakeField("STATION_UID", "1")}\n`;
  gabbi += `${adifMakeField("CERT_UID", "1")}\n`;
  gabbi += `${adifMakeField("CALL", callsign)}\n`;
  if (dxcc) gabbi += `${adifMakeField("DXCC", dxcc)}\n`;
  if (GRID) gabbi += `${adifMakeField("GRIDSQUARE", GRID)}\n`;
  gabbi += "<eor>\n\n";

  for (const qso of qsos) {
    const dxCall = lotwCall(qso.CALL);
    const gabiDate = tqslDate(qso.QSO_DATE);
    const gabiTime = tqslTime(qso.QSO_TIME);
    const forSign = { ...qso, CALL: dxCall, QSO_DATE: gabiDate, QSO_TIME: gabiTime };
    let raw = "";
    for (const f of TQ8_STATION_SIG_FIELDS) raw += (stationLoc[f] || "").trim();
    for (const f of TQ8_QSO_SIG_FIELDS) raw += (forSign[f] || "").trim();
    const signData = raw.toUpperCase();

    const signer = createSign("RSA-SHA1");
    signer.update(signData, "utf8");
    const b64sig = `${signer.sign(keyPem).toString("base64").match(/.{1,64}/g).join("\n")}\n`;

    gabbi += "<Rec_Type:8>tCONTACT\n";
    gabbi += `${adifMakeField("STATION_UID", "1")}\n`;
    gabbi += `${adifMakeField("CALL", dxCall)}\n`;
    gabbi += `${adifMakeField("BAND", qso.BAND.toUpperCase())}\n`;
    gabbi += `${adifMakeField("MODE", qso.MODE.toUpperCase())}\n`;
    if (qso.FREQ) gabbi += `${adifMakeField("FREQ", qso.FREQ)}\n`;
    if (qso.FREQ_RX) gabbi += `${adifMakeField("FREQ_RX", qso.FREQ_RX)}\n`;
    if (qso.PROP_MODE) gabbi += `${adifMakeField("PROP_MODE", qso.PROP_MODE.toUpperCase())}\n`;
    if (qso.SAT_NAME) gabbi += `${adifMakeField("SAT_NAME", qso.SAT_NAME.toUpperCase())}\n`;
    if (qso.BAND_RX) gabbi += `${adifMakeField("BAND_RX", qso.BAND_RX.toUpperCase())}\n`;
    gabbi += `${adifMakeField("QSO_DATE", gabiDate)}\n`;
    gabbi += `${adifMakeField("QSO_TIME", gabiTime)}\n`;
    gabbi += adifMakeField("SIGN_LOTW_V2.0", b64sig, "6");
    gabbi += `${adifMakeField("SIGNDATA", signData)}\n`;
    gabbi += "<eor>\n";
  }
  return { gabbi, keyPem, certB64, dxcc, grepped };
}

// ── the comparison ──────────────────────────────────────────────────────────

const qsos = parseAdifQsos(ADIF);

await check("ADIF parsing keeps only LoTW-valid records", () => {
  assert.strictEqual(qsos.length, 4, "the record missing MODE must be dropped");
  assert.deepStrictEqual(qsos.map((q) => q.CALL), ["W2XYZ", "DL1ABC", "VK3DEF/QRP", "ja1xyz"]);
  assert.strictEqual(qsos[2].BAND, "15M", "band inferred from 21.074 MHz");
  assert.strictEqual(qsos[1].QSO_TIME, "152000", "a 4-digit time is padded to 6");
});

await check("the certificate parses without openssl, with the DXCC entity", () => {
  const cert = readStationCertificate(p12Base64, P12_PASS);
  assert.strictEqual(cert.dxcc, "263", "DXCC read from extension 1.3.6.1.4.1.12348.1.4");
  assert.ok(cert.pkcs8Bytes.length > 1000, "a PKCS#8 private key came out");
  assert.strictEqual(cert.callsign, "W1AW");
});

await check("a wrong certificate password fails with a message that says so", () => {
  assert.throws(() => readStationCertificate(p12Base64, "wrong-password"), /password is incorrect/i);
});

await check("garbage in place of a .p12 is refused, not misreported", () => {
  assert.throws(() => readStationCertificate(btoa("not a certificate at all"), P12_PASS), /not a readable/i);
});

const cert = readStationCertificate(p12Base64, P12_PASS);
const reference = await opensslReference(qsos, { forceDxcc: cert.dxcc });
const mine = await buildGabbi({ qsos, cert, gridsquare: GRID, login: LOGIN });

await check("the certificate DER matches openssl's, byte for byte", () => {
  assert.strictEqual(cert.certB64, reference.certB64);
});

await check("the DXCC entity is read from the certificate, which openssl-grep never managed", () => {
  assert.strictEqual(cert.dxcc, "263", "read from the DER");
  assert.strictEqual(
    reference.grepped, "",
    "the old `openssl x509 -text` regex is expected to find nothing — openssl renders " +
    "an unknown extension as an ASCII dump, so the digits are preceded by dots where " +
    "that pattern wanted a digit. The old path therefore always omitted DXCC."
  );
});

await check("THE ONE THAT MATTERS: the GABBI is byte-identical to the openssl build", () => {
  if (mine !== reference.gabbi) {
    // Report the first divergence rather than dumping two multi-KB documents.
    const a = mine.split("\n");
    const b = reference.gabbi.split("\n");
    const i = a.findIndex((line, idx) => line !== b[idx]);
    assert.fail(
      `GABBI differs at line ${i + 1}:\n` +
      `  pure-JS: ${JSON.stringify(a[i]?.slice(0, 120))}\n` +
      `  openssl: ${JSON.stringify(b[i]?.slice(0, 120))}`
    );
  }
  assert.strictEqual(mine, reference.gabbi);
});

await check("every signature verifies against the certificate's public key", async () => {
  const { createVerify } = await import("node:crypto");
  // Read both fields by their declared ADIF length rather than up to the next "<".
  // SIGNDATA is followed by a newline, and including it in the verified bytes is
  // enough to fail every signature — which is exactly what a looser pattern did.
  const sigs = [...mine.matchAll(/<SIGN_LOTW_V2\.0:(\d+):6>([\s\S]*?)<SIGNDATA:(\d+)>/g)]
    .map((m) => ({
      sigB64: m[2].slice(0, Number(m[1])),
      signData: mine.slice(m.index + m[0].length, m.index + m[0].length + Number(m[3])),
    }));
  assert.strictEqual(sigs.length, 4, "one signature per QSO");
  for (const { sigB64, signData } of sigs) {
    const verifier = createVerify("RSA-SHA1");
    verifier.update(signData, "utf8");
    assert.ok(
      verifier.verify(await readFile(join(dir, "cert.pem"), "utf8"), Buffer.from(sigB64.replace(/\n/g, ""), "base64")),
      `signature does not verify for SIGNDATA ${signData.slice(0, 40)}…`
    );
  }
});

await check("the .tq8 is valid gzip that inflates back to the GABBI", async () => {
  const { gunzipSync } = await import("node:zlib");
  const { tq8, gabbi, qsoCount } = await buildSignedTq8({
    p12Base64, p12Pass: P12_PASS, adif: ADIF, gridsquare: GRID, login: LOGIN,
  });
  assert.strictEqual(qsoCount, 4);
  assert.strictEqual(tq8[0], 0x1f, "gzip magic byte 1");
  assert.strictEqual(tq8[1], 0x8b, "gzip magic byte 2");
  assert.strictEqual(gunzipSync(Buffer.from(tq8)).toString("utf8"), gabbi);
});

await check("an ADIF with no usable records is refused before any signing", async () => {
  await assert.rejects(
    buildSignedTq8({ p12Base64, p12Pass: P12_PASS, adif: "<EOH>\n<CALL:5>N0ONE<EOR>", gridsquare: GRID, login: LOGIN }),
    /No valid QSO records/
  );
});

await check("gzip round-trips a large log (the chunked base64 path)", async () => {
  const { gunzipSync } = await import("node:zlib");
  const big = "X".repeat(300_000);
  assert.strictEqual(gunzipSync(Buffer.from(await gzip(big))).toString("utf8"), big);
});

// The dry run is the only way to exercise a deployment without pushing a log at
// ARRL, so what it covers is what a deployer can actually verify. It has to do
// the real work and stop at the upload — proven here with the real certificate,
// which the endpoint tests cannot use.
await check("LOTW_DRY_RUN=1 signs for real and reports the result, skipping only the upload", async () => {
  const { onRequestPost } = await import("../functions/api/lotw/sign-upload.js");
  const res = await onRequestPost({
    request: new Request("https://webham.example/api/lotw/sign-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.7" },
      body: JSON.stringify({
        login: LOGIN, password: "not-used-in-a-dry-run",
        p12Base64, p12Pass: P12_PASS, adif: ADIF, gridsquare: GRID,
      }),
    }),
    env: { LOTW_DRY_RUN: "1" },
  });
  assert.strictEqual(res.status, 200);
  const payload = JSON.parse(await res.text());
  assert.strictEqual(payload.dryRun, true);
  // The signing really happened: the count matches the fixture and the .tq8 is
  // a plausible size rather than the zero a short-circuit would report.
  assert.strictEqual(payload.qsoCount, 4);
  assert.ok(payload.tq8Bytes > 500, `tq8Bytes ${payload.tq8Bytes} is too small to be four signed QSOs`);
  assert.match(payload.message, /Signed 4 QSOs/);
  assert.match(payload.message, /Upload skipped/);
});

await rm(dir, { recursive: true, force: true });
process.stdout.write(`\nlotw-sign: ${passed} assertions passed\n`);
