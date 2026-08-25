// QRZ / HamQTH callsign lookups. Ported from server.js's lookupWithQrz /
// lookupWithHamQth — both are pure fetch + flat-XML scraping, so they move to
// Workers unchanged apart from where credentials come from (see
// serverCredentialsAllowed in ./guard.js for why the env fallback is opt-in
// here but unconditional in server.js).
import { parseSimpleXmlTag } from "./respond.js";

async function fetchQrzSession(qrzUsername, qrzPassword) {
  const loginUrl = `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(
    qrzUsername
  )};password=${encodeURIComponent(qrzPassword)}`;
  const response = await fetch(loginUrl);
  const xmlText = await response.text();
  const sessionKey = parseSimpleXmlTag(xmlText, "Key");
  const errorText = parseSimpleXmlTag(xmlText, "Error");
  if (!sessionKey) {
    throw new Error(errorText || "QRZ login failed");
  }
  return sessionKey;
}

export async function lookupWithQrz(callsign, creds = {}) {
  const qrzUsername = creds.qrzUser;
  const qrzPassword = creds.qrzPass;
  if (!qrzUsername || !qrzPassword) {
    return null;
  }
  const sessionKey = await fetchQrzSession(qrzUsername, qrzPassword);
  const lookupUrl = `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(
    sessionKey
  )};callsign=${encodeURIComponent(callsign)}`;
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
    country: parseSimpleXmlTag(lookupXml, "country"),
  };
}

async function fetchHamQthSession(username, password) {
  const sessionUrl = `https://www.hamqth.com/xml.php?u=${encodeURIComponent(
    username
  )}&p=${encodeURIComponent(password)}`;
  const response = await fetch(sessionUrl);
  const xmlText = await response.text();
  const sessionId = parseSimpleXmlTag(xmlText, "session_id");
  const errorText = parseSimpleXmlTag(xmlText, "error");
  if (!sessionId) {
    throw new Error(errorText || "HamQTH login failed");
  }
  return sessionId;
}

export async function lookupWithHamQth(callsign, creds = {}) {
  const username = creds.hamqthUser;
  const password = creds.hamqthPass;
  if (!username || !password) {
    return null;
  }
  const sessionId = await fetchHamQthSession(username, password);
  const lookupUrl = `https://www.hamqth.com/xml.php?id=${encodeURIComponent(
    sessionId
  )}&callsign=${encodeURIComponent(callsign)}&prg=webham`;
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
    operatorName:
      [parseSimpleXmlTag(xmlText, "adr_name"), parseSimpleXmlTag(xmlText, "nick")].filter(Boolean)[0] || "",
    qth: [parseSimpleXmlTag(xmlText, "qth"), parseSimpleXmlTag(xmlText, "district")]
      .filter(Boolean)
      .join(", "),
    grid: parseSimpleXmlTag(xmlText, "grid"),
    country: parseSimpleXmlTag(xmlText, "country"),
  };
}
