// Signing a LoTW upload, in portable JavaScript.
//
// ARRL accepts a gzipped GABBI ".tq8" file: a TQSL_IDENT header, a tCERT record
// carrying the station certificate, a tSTATION record, and one signed tCONTACT
// per QSO. Each contact carries an RSA-SHA1 signature over a canonical
// concatenation of its own fields ("SIGNDATA"), made with the private key from
// the operator's .p12.
//
// Nothing here may use a subprocess or the filesystem, because this runs on the
// Cloudflare Workers runtime as well as under Node. That rules out the obvious
// implementation — shelling out to the openssl CLI and staging the key through a
// temp file — and dictates every choice below:
//
//   PKCS#12 parsing   node-forge (./forge.esm.js). WebCrypto cannot do PKCS#12,
//                     and ARRL issues certificates with legacy PBE
//                     (pbeWithSHA1And40BitRC2-CBC) — the reason the old code
//                     needed `openssl pkcs12 -legacy`. forge reads it directly.
//   DXCC entity       read from the certificate's private extension
//                     1.3.6.1.4.1.12348.1.4, where `openssl x509 -text` used to
//                     be grepped for it.
//   RSA-SHA1 signing  WebCrypto. Deliberately NOT forge: forge's pure-JS RSA is
//                     orders of magnitude slower, and this signs once per QSO —
//                     a contest log would blow any request budget. WebCrypto does
//                     it in ~0.5 ms, so a 1000-QSO log costs about 0.6 s.
//   gzip              CompressionStream, present in both Workers and Node 18+.
//
// RSA PKCS#1 v1.5 signatures are deterministic, so this produces byte-identical
// signatures to the openssl path for the same key and data — verified in
// test/test-lotw-sign.mjs, which builds a certificate, signs a log both ways, and
// compares the emitted GABBI.
import forge from "./forge.esm.js";

// The LoTW private extension holding the DXCC entity number.
const DXCC_OID = "1.3.6.1.4.1.12348.1.4";

// sigspec LOTW 2.0 field order — drives what gets concatenated into SIGNDATA.
const TQ8_STATION_SIG_FIELDS = [
  "AU_STATE", "CA_PROVINCE", "CA_US_PARK", "CN_PROVINCE", "CQZ", "DX_US_PARK",
  "FI_KUNTA", "GRIDSQUARE", "IOTA", "ITUZ", "JA_CITY_GUN_KU", "JA_PREFECTURE",
  "RU_OBLAST", "US_COUNTY", "US_PARK", "US_STATE",
];
const TQ8_QSO_SIG_FIELDS = [
  "BAND", "BAND_RX", "CALL", "FREQ", "FREQ_RX", "MODE", "PROP_MODE",
  "QSO_DATE", "QSO_TIME", "SAT_NAME",
];

// Same band plan the client uses, for QSOs that carry a frequency but no band.
const ADIF_BAND_FROM_FREQ_MHZ = [
  [1.8, 2.0, "160M"], [3.5, 4.0, "80M"], [7.0, 7.3, "40M"],
  [10.1, 10.15, "30M"], [14.0, 14.35, "20M"], [18.068, 18.168, "17M"],
  [21.0, 21.45, "15M"], [24.89, 24.99, "12M"], [28.0, 29.7, "10M"],
  [50.0, 54.0, "6M"],
];

function bandFromFreqMhz(freqStr) {
  const mhz = Number.parseFloat(freqStr);
  if (!Number.isFinite(mhz)) return "";
  for (const [lo, hi, band] of ADIF_BAND_FROM_FREQ_MHZ) {
    if (mhz >= lo && mhz < hi) return band;
  }
  return "";
}

function adifMakeField(name, value, type) {
  const v = String(value);
  return type ? `<${name}:${v.length}:${type}>${v}` : `<${name}:${v.length}>${v}`;
}

// Strip informal Q-code suffixes (/QRP, /QRO) that LoTW rejects. Valid suffixes
// are call areas, /P, /M, /MM, /AM, or geographic prefixes.
function lotwCall(call) {
  return call.toUpperCase().replace(/\/Q[A-Z0-9]+$/, "");
}

// TQSL converts ADIF date/time before embedding and before signing.
const tqslDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const tqslTime = (t) => `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;

// Parse ADIF text into QSO field objects. Only records with the fields LoTW
// requires are kept; the rest are silently skipped, as they always were.
export function parseAdifQsos(adif) {
  const eohMatch = adif.match(/<EOH>/i);
  const body = eohMatch ? adif.slice(adif.indexOf(eohMatch[0]) + eohMatch[0].length) : adif;
  const qsos = [];
  for (const rec of body.split(/<EOR>/i)) {
    const qso = {};
    let pos = 0;
    while (pos < rec.length) {
      const lt = rec.indexOf("<", pos);
      if (lt < 0) break;
      const gt = rec.indexOf(">", lt);
      if (gt < 0) break;
      const parts = rec.slice(lt + 1, gt).split(":");
      const fname = parts[0].toUpperCase();
      const flen = parts[1] ? Number.parseInt(parts[1], 10) : 0;
      pos = gt + 1;
      if (!fname || fname === "EOR" || fname === "EOH") continue;
      const val = flen > 0 ? rec.slice(pos, pos + flen).trim() : "";
      pos += flen;
      if (val) qso[fname] = val;
    }
    const time = qso.TIME_ON || qso.QSO_TIME || "";
    const band = qso.BAND || bandFromFreqMhz(qso.FREQ || qso.FREQ_RX || "");
    if (qso.CALL && qso.QSO_DATE && band && qso.MODE && time) {
      qso.BAND = band;
      qso.QSO_TIME = time.length < 6 ? time.padEnd(6, "0") : time.slice(0, 6);
      qsos.push(qso);
    }
  }
  return qsos;
}

// ── certificate ─────────────────────────────────────────────────────────────

// Pull the private key, the leaf certificate and the DXCC entity out of a .p12.
// Throws a message safe to show an operator — a bad passphrase is by far the
// commonest failure and deserves to say so.
export function readStationCertificate(p12Base64, p12Pass) {
  let p12;
  try {
    const der = forge.util.decode64(p12Base64);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), p12Pass);
  } catch (error) {
    // forge reports a wrong password as a MAC verification failure.
    if (/MAC|password|invalid/i.test(String(error?.message))) {
      throw new Error("The certificate password is incorrect.");
    }
    throw new Error("That file is not a readable .p12 certificate.");
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
    || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]
    || [];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBags.length || !keyBags[0].key) throw new Error("The certificate contains no private key.");
  if (!certBags.length || !certBags[0].cert) throw new Error("The certificate file contains no certificate.");

  const key = keyBags[0].key;
  // The leaf, not a CA in the chain: LoTW's own certificates carry the DXCC
  // extension, so prefer one that has it and fall back to the first.
  const cert = certBags.find((b) => b.cert?.extensions?.some((e) => e.id === DXCC_OID))?.cert
    ?? certBags[0].cert;

  // The DXCC entity, from the private extension. Both ASN.1 encodings seen in the
  // wild are handled: an INTEGER, and a PrintableString of decimal digits.
  //
  // The openssl implementation did this by grepping `x509 -text` for
  //   /1\.3\.6\.1\.4\.1\.12348\.1\.4:\s*\n\s*(\d+)/
  // which never actually matched: openssl renders an unknown extension as an
  // ASCII dump, so an INTEGER prints as "...." and a PrintableString as "..263"
  // — in both cases the two leading dots sit where that regex demands a digit.
  // So the old path always produced an empty DXCC and omitted the field. Reading
  // the DER properly is what TQSL itself does, and the value comes from the
  // certificate, so it cannot disagree with the certificate.
  let dxcc = "";
  const ext = cert.extensions?.find((e) => e.id === DXCC_OID);
  if (ext) {
    try {
      const decoded = forge.asn1.fromDer(ext.value);
      const raw = decoded.value;
      if (decoded.type === forge.asn1.Type.INTEGER) {
        let n = 0;
        for (let i = 0; i < raw.length; i++) n = (n << 8) | (raw.charCodeAt(i) & 0xff);
        dxcc = String(n);
      } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
        dxcc = raw.trim();
      }
    } catch { /* an unreadable extension is not worth failing the upload over */ }
  }

  // Base64 DER of the certificate for the tCERT record — the same content the
  // old code recovered by filtering PEM lines out of `openssl pkcs12 -nokeys`.
  //
  // LF line endings, not CRLF: forge's encode64 wraps with \r\n, while the
  // openssl path split a PEM on \n and rejoined with \n. The openssl output is
  // the one ARRL has been accepting, so it is the one to match — and the
  // difference is inside a signed document, so it is not cosmetic.
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const certB64 = `${forge.util.encode64(certDer, 64).replace(/\r\n/g, "\n")}\n`;

  // PKCS#8 DER, which is the form WebCrypto's importKey takes.
  const pkcs8 = forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))).getBytes();

  return {
    dxcc,
    certB64,
    callsign: cert.subject.getField("CN")?.value || "",
    pkcs8Bytes: Uint8Array.from(pkcs8, (c) => c.charCodeAt(0)),
  };
}

// ── GABBI ───────────────────────────────────────────────────────────────────

function signDataFor(stationLoc, qso) {
  let raw = "";
  for (const f of TQ8_STATION_SIG_FIELDS) raw += (stationLoc[f] || "").trim();
  for (const f of TQ8_QSO_SIG_FIELDS) raw += (qso[f] || "").trim();
  return raw.toUpperCase();
}

const b64 = (bytes) => {
  // Chunked for the same reason js/utils.js is: one argument per byte overflows
  // the call stack on a large input.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

// Build the uncompressed GABBI document. Separate from the gzip step so tests can
// compare it against the openssl implementation's output directly — gzip levels
// differ between zlib and CompressionStream, and that difference is not meaningful.
export async function buildGabbi({ qsos, cert, gridsquare, login }) {
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", cert.pkcs8Bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["sign"]);

  const callsign = (qsos[0].STATION_CALLSIGN || login).trim().toUpperCase();
  const certUid = 1;
  const stationUid = 1;
  const stationLoc = { GRIDSQUARE: gridsquare };

  let gabbi = `${adifMakeField("TQSL_IDENT", "WebHam Lib: V2.8.6 Config: V11.34 AllowDupes: false")}\n\n`;

  gabbi += "<Rec_Type:5>tCERT\n";
  gabbi += `${adifMakeField("CERT_UID", String(certUid))}\n`;
  // certB64 already ends with \n — TQSL puts <eor> directly after.
  gabbi += adifMakeField("CERTIFICATE", cert.certB64);
  gabbi += "<eor>\n\n";

  gabbi += "<Rec_Type:8>tSTATION\n";
  gabbi += `${adifMakeField("STATION_UID", String(stationUid))}\n`;
  gabbi += `${adifMakeField("CERT_UID", String(certUid))}\n`;
  gabbi += `${adifMakeField("CALL", callsign)}\n`;
  if (cert.dxcc) gabbi += `${adifMakeField("DXCC", cert.dxcc)}\n`;
  if (gridsquare) gabbi += `${adifMakeField("GRIDSQUARE", gridsquare)}\n`;
  gabbi += "<eor>\n\n";

  const encoder = new TextEncoder();
  for (const qso of qsos) {
    const dxCall = lotwCall(qso.CALL);
    const gabiDate = tqslDate(qso.QSO_DATE);
    const gabiTime = tqslTime(qso.QSO_TIME);
    const signData = signDataFor(stationLoc, { ...qso, CALL: dxCall, QSO_DATE: gabiDate, QSO_TIME: gabiTime });

    const sigBytes = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(signData)));
    // Wrapped at 64 characters with a trailing newline on each line, matching TQSL.
    const b64sig = `${b64(sigBytes).match(/.{1,64}/g).join("\n")}\n`;

    gabbi += "<Rec_Type:8>tCONTACT\n";
    gabbi += `${adifMakeField("STATION_UID", String(stationUid))}\n`;
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

  return gabbi;
}

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// End to end: .p12 + ADIF in, gzipped .tq8 out. Throws with an operator-safe
// message; callers must not echo anything else.
//
// maxQsos exists for the hosted build. Signing is one RSA operation per QSO —
// measured at roughly 0.6 ms each on the Workers runtime, so a 1000-QSO log is
// about 0.6 s of straight CPU — and a serverless invocation has a CPU ceiling
// that varies by plan. A cap turns "the log was too big" into a message the
// operator can act on instead of a request killed part-way through signing.
// The local server passes no cap: it has no such ceiling.
export async function buildSignedTq8({ p12Base64, p12Pass, adif, gridsquare, login, maxQsos = 0 }) {
  const qsos = parseAdifQsos(adif);
  if (qsos.length === 0) throw new Error("No valid QSO records found in ADIF.");
  if (maxQsos > 0 && qsos.length > maxQsos) {
    throw new Error(
      `That log has ${qsos.length} QSOs; this server signs at most ${maxQsos} at a time. ` +
        `Upload it in smaller batches, or run WebHam locally where there is no limit.`
    );
  }
  const cert = readStationCertificate(p12Base64, p12Pass);
  const gabbi = await buildGabbi({ qsos, cert, gridsquare, login });
  return { tq8: await gzip(gabbi), gabbi, qsoCount: qsos.length };
}

// Post a signed .tq8 and interpret ARRL's reply. Shared so the local server and
// the Pages Function report the same thing for the same response.
export async function uploadTq8({ tq8, login, password }) {
  const formData = new FormData();
  formData.set("upfile", new Blob([tq8], { type: "application/octet-stream" }), "webham-log.tq8");
  const url = `https://lotw.arrl.org/lotwuser/upload?login=${encodeURIComponent(login)}&password=${encodeURIComponent(password)}`;
  const response = await fetch(url, { method: "POST", body: formData });
  const resultText = await response.text();

  const uplResult = resultText.match(/<!--\s*\.UPL\.\s*(\w+)\s*-->/i)?.[1]?.toLowerCase() ?? null;
  const uplMessage = resultText.match(/<!--\s*\.UPLMESSAGE\.\s*([\s\S]*?)\s*-->/i)?.[1]?.trim() ?? "";

  if (!response.ok) return { status: 502, error: `LoTW upload failed (${response.status}).` };
  if (uplResult === "rejected") return { status: 401, error: `LoTW rejected the upload${uplMessage ? `: ${uplMessage}` : "."}` };
  if (uplResult === "accepted") return { status: 200, message: uplMessage || "LoTW accepted the upload." };

  const collapsed = resultText.replace(/\s+/g, " ").trim();
  if (/password is incorrect|login failed|unknown user/i.test(collapsed)) {
    return { status: 401, error: "LoTW rejected the provided credentials." };
  }
  return { status: 200, message: collapsed.slice(0, 280) || "LoTW accepted the upload." };
}
