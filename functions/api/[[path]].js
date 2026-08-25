// Catch-all for /api/* paths that match no other Function.
//
// Without this, Pages falls through an unmatched /api/* request to static asset
// serving, which answers with index.html and HTTP 200. Any client fetch then
// receives HTML where it parses JSON and reports something like
// "Server error (200): <!DOCTYPE html>" — a typo in an endpoint path or a
// half-deployed route would masquerade as a server bug instead of a 404.
//
// Pages routes more specific Functions ahead of a [[catchall]], so the real
// endpoints in this directory keep handling their own paths; only genuinely
// unknown ones land here.
import { json } from "../_lib/respond.js";

export function onRequest({ request }) {
  const { pathname } = new URL(request.url);
  return json(404, { error: `No such API endpoint: ${pathname}` });
}
