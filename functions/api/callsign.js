// POST /api/callsign — QRZ-then-HamQTH operator lookup for the logger's
// callsign field (js/connectors/lookup.js).
//
// Credentials normally arrive in the request body, decrypted by the browser
// from its own local store, so this endpoint holds no secrets of its own. The
// env-var fallback that server.js always applies is opt-in here — see
// serverCredentialsAllowed in ../_lib/guard.js for why.
import { json, readJsonBody, firstText } from "../_lib/respond.js";
import { guard, serverCredentialsAllowed } from "../_lib/guard.js";
import { lookupWithQrz, lookupWithHamQth } from "../_lib/lookup.js";

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, {
    bucket: "callsign",
    max: 30,
    windowMs: 60 * 1000,
    tooManyMessage: "Too many callsign lookups. Try again in a minute.",
  });
  if (blocked) return blocked;

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return json(400, { error: error.message });
  }

  const callsign = firstText(body?.call).toUpperCase();
  if (!callsign) {
    return json(400, { error: "Missing field: call" });
  }
  if (!/^[A-Z0-9/]{3,}$/.test(callsign)) {
    return json(400, { error: "Callsign format is invalid." });
  }

  const useEnv = serverCredentialsAllowed(env);
  const creds = {
    qrzUser: firstText(body?.qrzUser) || (useEnv ? env.QRZ_USERNAME : ""),
    qrzPass: firstText(body?.qrzPass) || (useEnv ? env.QRZ_PASSWORD : ""),
    hamqthUser: firstText(body?.hamqthUser) || (useEnv ? env.HAMQTH_USERNAME : ""),
    hamqthPass: firstText(body?.hamqthPass) || (useEnv ? env.HAMQTH_PASSWORD : ""),
  };

  try {
    const qrzResult = await lookupWithQrz(callsign, creds);
    if (qrzResult) {
      return json(200, { message: "Lookup complete", result: qrzResult });
    }
    const hamQthResult = await lookupWithHamQth(callsign, creds);
    if (hamQthResult) {
      return json(200, { message: "Lookup complete", result: hamQthResult });
    }
    return json(503, {
      error:
        "No lookup credentials available, or the callsign was not found. Add your QRZ or HamQTH login in Settings.",
    });
  } catch (error) {
    return json(502, { error: `Lookup provider error: ${error.message}` });
  }
}
