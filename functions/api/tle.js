// GET /api/tle — proxies celestrak's amateur-satellite TLE set for the
// satellites app (js/apps/satellites/index.js). The browser cannot fetch it
// directly: celestrak sends no CORS headers.
import { json, text } from "../_lib/respond.js";
import { guard } from "../_lib/guard.js";

const TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle";

export async function onRequestGet({ request }) {
  const blocked = guard(request, {
    bucket: "tle",
    max: 5,
    windowMs: 60 * 1000,
    tooManyMessage: "Too many TLE requests. Try again in a minute.",
  });
  if (blocked) return blocked;

  try {
    const response = await fetch(TLE_URL, {
      headers: {
        "User-Agent": "WebHam/1.0 (https://github.com/rfvx/WebHam; ham radio logger)",
      },
      // Edge-cache the upstream fetch for an hour. TLEs are published a few
      // times a day, so this collapses many browser hits into one origin hit
      // and keeps WebHam a well-behaved celestrak client — the same intent as
      // server.js's max-age=3600 response header, enforced a layer earlier.
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!response.ok) {
      return json(502, { error: `TLE fetch failed (${response.status} ${response.statusText})` });
    }
    return text(200, await response.text(), { "Cache-Control": "max-age=3600" });
  } catch (error) {
    return json(502, { error: `TLE fetch error: ${error.message}` });
  }
}
