// Shared response helpers for the Cloudflare Pages Functions under
// functions/api/. Directories and files beginning with "_" are not routed by
// Pages, so this is an importable module rather than an endpoint.
//
// server.js remains the local-dev server and owns the same endpoints for
// `npm start`; this tree is the deployed-on-Pages implementation. The two are
// deliberately separate (CommonJS Node http vs. ESM Workers fetch handlers) —
// see README's "Deploying to Cloudflare Pages" for the split and its cost.

// Mirrors server.js's SECURITY_HEADERS for API responses. Static assets get
// the same set via the top-level _headers file, which Pages applies to them
// (a Function's Response is NOT passed through _headers, so JSON responses
// have to set these themselves).
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(self), microphone=(self), camera=(), payment=(), usb=(self), interest-cohort=()",
};

export function json(statusCode, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function text(statusCode, body, extraHeaders = {}) {
  return new Response(body, {
    status: statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function firstText(value = "") {
  return String(value).trim();
}

// Same permissive tag scrape server.js uses for the QRZ/HamQTH XML replies.
// Both APIs return flat, single-level documents, so a real XML parser buys
// nothing here — and Workers has no DOMParser anyway.
export function parseSimpleXmlTag(xmlText, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const match = xmlText.match(pattern);
  return firstText(match?.[1] || "");
}

// Body-size ceiling matching server.js's readJsonBody guard (512 KB): an
// unbounded JSON.parse of a request body is a memory-exhaustion vector.
const MAX_BODY_BYTES = 512 * 1024;

export async function readJsonBody(request) {
  const raw = await request.text();
  // Workers strings are UTF-16; measure the encoded byte length, not .length.
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error("Request body is too large.");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Body must be valid JSON.");
  }
}
