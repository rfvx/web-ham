# Deploying WebHam

WebHam runs two ways. Both serve the same static app and the same four `/api/*`
endpoints; they differ only in what hosts them.

| | Local server | Cloudflare Pages |
| --- | --- | --- |
| Serves the app | `server.js` (or `server.pl` / `start-server.ps1`) | Pages static hosting |
| Serves `/api/*` | `server.js` route handlers | Pages Functions in `functions/` |
| Web Serial / PWA install | yes, on `http://localhost` | yes, over HTTPS |
| Public URL | none | [web-ham.com](https://web-ham.com) |
| rigctld bridge (`ws://localhost:4532`) | yes | yes — the bridge runs on the operator's own machine |
| LoTW signing | no limits | capped, see below |

The API code is shared where it matters: the LoTW signer lives in
`functions/_lib/tq8.js` and the LoTW report query in `functions/_lib/lotw-query.js`.
**Both** servers import both, so the hosted build and the local server produce
the same bytes, and send ARRL the same query, rather than agreeing by inspection.
What that query is and why is [docs/lotw-rate-limits.md](lotw-rate-limits.md).

## Building for Pages

```bash
npm run build:pages     # -> dist/
```

`tools/build-pages.mjs` copies an explicit allowlist (`SHIP`) into `dist/` and
refuses to ship anything on the `DO_NOT_SHIP` list — `server.js`, `test/`,
`tools/`, `docs/`. It also re-reads `sw.js` afterwards and verifies every path in
the service worker's precache list exists in the output, so an offline-breaking
build fails at build time instead of on somebody's phone in a field.

`check.sh` runs this build and asserts both properties.

Two config files are copied **into** `dist/`, because Cloudflare reads them from
the build output directory:

- `_headers` — the security headers and the CSP
- `_routes.json` — scopes Functions invocation to `/api/*`, so static assets are
  served from cache and never wake a Function

`functions/` is the exception: it stays at the **project root** and is not copied
into `dist/`. Cloudflare discovers Functions at the root directory of the
project, not in the build output. Moving it into `dist/` silently disables every
`/api/*` endpoint — the routes fall through to the static handler and return
`index.html`.

## Two Cloudflare targets

Cloudflare has been folding Pages into Workers, and which setup flow the
dashboard offers has moved around. The repo supports both, from one set of
handlers — `functions/api/` — so pick whichever the dashboard gives you.

### As a Pages project

| Setting | Value |
| --- | --- |
| Build command | `npm run build:pages` |
| Build output directory | `dist` |
| Root directory | repository root |

Or from a terminal, which also creates the project:

```bash
npm run build:pages
npx wrangler pages deploy dist --project-name=webham
```

Pages routes `/api/*` by the layout of `functions/` and needs no other wiring.

### As a Worker with static assets

The Workers setup flow has no "build output directory" field, and it does not
read `functions/` — that convention is Pages-only. `wrangler.jsonc` and
`worker.js` cover the difference:

| Setting | Value |
| --- | --- |
| Build command | `npm run build:pages` |
| Deploy command | `npx wrangler deploy` |

`worker.js` is a routing table over the same handler modules. There is no second
copy of any endpoint — but the table is hand-written, so it is the one place the
two targets can silently disagree: add an endpoint to `functions/api/` and forget
`worker.js`, and it works on Pages and 404s on Workers.
`test/test-worker-routes.mjs` derives the expected table from the directory and
fails on any drift, including a route bound to the wrong method.

Verified locally: `_headers` is applied to static assets on this target too
(`wrangler dev` reports `Parsed 8 valid header rules`), so the CSP is not lost by
choosing Workers.

`not_found_handling: "404-page"` is set so an unmatched path serves `404.html`
rather than `index.html` — otherwise a mistyped URL returns the app with a 200.

## Environment variables

None are required — the app works with the operator entering their own
credentials in the browser.

| Variable | Effect |
| --- | --- |
| `QRZ_USERNAME` / `QRZ_PASSWORD` | Server-side callsign lookup credentials |
| `HAMQTH_USERNAME` / `HAMQTH_PASSWORD` | Same, for HamQTH |
| `ALLOW_SERVER_CREDENTIALS` | Must be `1` before the above are used at all. Without it a public deployment would spend the deployer's lookup quota on every visitor, so the credentials are ignored rather than silently shared. |
| `LOTW_DRY_RUN` | `1` makes `/api/lotw/sign-upload` return success without contacting ARRL. For exercising a deployment end to end without pushing a log. |
| `LOTW_MAX_QSOS` | Raises or lowers the per-request QSO cap (default 2000). See below. |

Set credentials as **encrypted** Pages environment variables, not plaintext.

## The LoTW QSO cap

Signing is one RSA-SHA1 signature per QSO. Measured on the Workers runtime
(`wrangler pages dev`, RSA-2048):

| QSOs | Time |
| --- | --- |
| 50 | 48 ms |
| 200 | 157 ms |
| 1000 | 677 ms |

So roughly 0.6 ms per QSO after a fixed ~45 ms for parsing the PKCS#12 and
importing the key — and that time is nearly all CPU, since it is RSA.

A serverless invocation has a CPU ceiling that depends on the Cloudflare plan.
`/api/lotw/sign-upload` therefore refuses a log over `LOTW_MAX_QSOS` (default
2000, about 1.2 s of signing) **before** it starts signing, with a message
telling the operator to upload in smaller batches or run WebHam locally. The
alternative is worse: a request killed part-way through signing looks to the
operator like the upload silently failed.

Check your plan's documented CPU-time-per-invocation limit before raising it. The
local server passes no cap, because it has no such ceiling.

## Content Security Policy

The CSP is defined in **four** places that must agree — `_headers` for Pages, and
`server.js` / `server.pl` / `start-server.ps1` for local use. `check.sh` asserts
they carry the same directives, because a CSP that is correct in three of four
places is a feature that works locally and breaks only once deployed.

`script-src` uses a hash for the one inline bootstrap script and never
`unsafe-inline`. If you change that inline script, recompute the hash — the
command is in `index.html` next to it — and update all four.

Notable allowances, each earning its place:

| Directive | Why |
| --- | --- |
| `wasm-unsafe-eval` | the vendored FT8 decoder is WASM |
| `connect-src ws://localhost:*` | the optional rigctld bridge runs on the operator's own machine |
| `img-src https://unpkg.com` | Leaflet's marker images |

## Verifying a deployment

```bash
./check.sh          # static checks, layering, CSP agreement, Pages build
npm test            # every suite in test/
npx wrangler pages dev dist
```

Then, against the running dev server:

- `GET /api/time` → 200 with a `serverMs`
- `GET /api/lotw/sign-upload` → 405 JSON, not an HTML 404
- `POST /api/definitely-not-a-route` → 404 **JSON** naming the path
- any `/api/*` with a foreign `Origin` → 403

That last set matters more than it looks: Pages serves `index.html` for unmatched
paths by default, so a mistyped endpoint returns HTML with status 200 and the
client reports a JSON parse error instead of a missing route. `functions/api/[[path]].js`
exists to turn that into an honest 404.
