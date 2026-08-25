// GET /api/time — server clock, used by the FT8 app to correct local drift
// against the 15-second slot boundary (js/apps/ft8/index.js).
//
// No rate limit: server.js does not gate this one either, and it does no
// upstream work — it just reads the clock.
import { json } from "../_lib/respond.js";
import { checkSameOrigin } from "../_lib/guard.js";

export function onRequestGet({ request }) {
  const blocked = checkSameOrigin(request);
  if (blocked) return blocked;
  return json(200, { serverMs: Date.now() });
}
