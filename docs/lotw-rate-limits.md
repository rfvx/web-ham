# LoTW rate limits, and what WebHam does about them

ARRL publishes no numeric rate limit for Logbook of The World. What it publishes
instead is a set of constraints and a warning, and the operative parts for a
logging application are these:

- **One download at a time per account.** A second report request while one is
  still running is refused rather than queued.
- **A download abuse detector.** It exists specifically because applications
  were re-downloading a user's entire log every time the user logged in, which
  ARRL describes as a significant load problem. Its response is the string
  `Invalid Request` — served with **HTTP 200**, not an error status.
- **An incremental cursor.** Every report carries `APP_LoTW_LASTQSL` in its ADIF
  header. Feeding that value back as `qso_qslsince` on the next query is the
  documented way to ask "what has changed since last time", and it is what keeps
  a sync proportional to new confirmations instead of to log size.

Sources: the LoTW developer documentation (`lotw.arrl.org/lotw-help/developer-query-qsos-qsls/`,
`lotw.arrl.org/lotw-help/developer-information/`) and ARRL's
[Integrating Logbook of the World with Logging Applications](https://www.arrl.org/files/file/LoTW_Developer/DeveloperIntro.pdf).
The `Invalid Request` behaviour and the reason behind it are described in
[the Log4OM forum's LoTW download threads](https://forum.log4om.com/viewtopic.php?t=1737)
and in the [ARRL-LoTW group archives](https://groups.arrl.org/g/ARRL-LoTW/topic/90510425).

The absence of a published number is not permission to poll freely. It means the
limit is enforced by a heuristic whose threshold nobody outside ARRL knows, and
whose penalty lands on the operator's account rather than on the application.

## What WebHam does

### The query is incremental after the first sync

`functions/_lib/lotw-query.js` builds one of two queries:

| Case | Query | When |
| --- | --- | --- |
| Bootstrap | `qso_qsl=no&qso_startdate=1945-11-15` | No stored cursor — a first sync, or a log restored into a fresh browser |
| Incremental | `qso_qsl=yes&qso_qslsince=<APP_LoTW_LASTQSL>` | Every sync after that |

Both pass `qso_qsldetail=yes` so a confirmation is recognisable from the record.

The bootstrap pull is the one case where downloading the whole log is the point:
it establishes which QSOs LoTW already holds, including ones uploaded from
TrustedQSL or another logger before WebHam existed. It runs **once**. The cursor
it returns is stored under `web-ham-logger.lotw-last-qsl`, and its presence is
what marks the station as bootstrapped.

An empty report can omit `APP_LoTW_LASTQSL`. The client keeps its existing cursor
in that case rather than clearing it — clearing it would silently promote the
next sync back to a full pull, which is exactly the pattern the abuse detector
was built to catch.

### `Invalid Request` is surfaced, not swallowed

`classifyLotwReport()` reads the body, because LoTW reports failure with HTTP
200. It maps the limiter's reply to **429** with a message that names the cause
and the remedy. Without this the report parses to zero records and the operator
is told "synced, no new confirmations" — indefinitely, and with no hint that
anything is wrong. A response with no ADIF header at all is treated the same way
rather than as an empty log.

### Syncs are spaced

`js/apps/logger/index.js` refuses a sync within **5 minutes** of the last
successful one and says when to try again. A confirmation cannot appear faster
than the other operator uploading their side of the QSO, so there is nothing to
win by asking sooner.

Both `/api/lotw/*` endpoints additionally share a server-side bucket of **10
requests per 15 minutes per IP** (`functions/_lib/guard.js`). That is a guard
against a misbehaving or hostile client, not the primary throttle — the client
cooldown is.

### Uploads send only what has not been sent

`signAndUploadToLotw()` uploads QSOs whose `lotw_sent` is not `Y`, and marks only
those on success. Re-sending accepted QSOs costs an RSA signature each on the way
out and is discarded as a duplicate on the way in. On a hosted deployment it is
also what pushes a long log past the per-request QSO cap
([docs/deploying.md](deploying.md)) for no gain.

## What is deliberately not done

- **No background or scheduled sync.** Syncing is an operator action. A timer
  would multiply every one of the above by the number of open tabs.
- **No retry on 429.** The limiter is cleared by waiting, and an automatic retry
  is the behaviour that trips it in the first place.
- **No numeric limit claimed in the UI.** WebHam's 5-minute spacing is its own
  policy, not a published ARRL figure, and is described as such wherever it
  appears.
