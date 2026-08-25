// Worker entry point, for deploying WebHam as a Worker with static assets
// (`wrangler deploy`) rather than as a Pages project (`wrangler pages deploy`).
//
// Cloudflare has been steering new projects toward Workers, and the Workers
// setup flow has no "build output directory" field and does not read the
// functions/ directory — that routing convention is Pages-only. So this file
// does by hand what Pages does by convention: map a path to a handler.
//
// It imports the same modules functions/api/ exposes to Pages. There is no
// second copy of any endpoint; if you add one, add it to ROUTES below and to
// functions/api/ once. test/test-pages-functions.mjs covers the handlers
// themselves, and test/test-worker-routes.mjs covers this table agreeing with
// the directory.
//
// Static assets are served by the assets binding declared in wrangler.jsonc.
// Requests only reach this Worker when no asset matches, or under /api/*.
import { onRequestGet as timeGet } from "./functions/api/time.js";
import { onRequestPost as callsignPost } from "./functions/api/callsign.js";
import { onRequestGet as tleGet } from "./functions/api/tle.js";
import { onRequestPost as lotwDownloadPost } from "./functions/api/lotw/download.js";
import {
  onRequestPost as signUploadPost,
  onRequestGet as signUploadGet,
} from "./functions/api/lotw/sign-upload.js";
import { onRequest as apiCatchAll } from "./functions/api/[[path]].js";

// path -> { METHOD: handler }. Mirrors the file layout under functions/api/.
// Exported so test/test-worker-routes.mjs can hold it against that directory.
export const ROUTES = {
  "/api/time": { GET: timeGet },
  "/api/callsign": { POST: callsignPost },
  "/api/tle": { GET: tleGet },
  "/api/lotw/download": { POST: lotwDownloadPost },
  "/api/lotw/sign-upload": { POST: signUploadPost, GET: signUploadGet },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const methods = ROUTES[url.pathname];
      // An unknown path, or a known path with the wrong method, both go to the
      // catch-all so the client gets JSON. Falling through to the asset handler
      // would serve index.html with a 200 and the client would report a JSON
      // parse error against HTML instead of a missing route.
      const handler = methods?.[request.method];
      if (!handler) return apiCatchAll({ request, env, ctx });
      return handler({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },
};
