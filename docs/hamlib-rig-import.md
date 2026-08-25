# Importing the rig catalogue from Hamlib

**Status:** wired in. `js/connectors/cat.js` now builds `RADIO_PROFILES` from
the generated catalogue, keeping only the four profiles Hamlib cannot describe
("No Radio" and the three rigctld daemon entries). The catalogue has adopted
Hamlib's model numbers, and a one-time `localStorage` migration renumbers saved
profiles.

## Why this shape

WebHam speaks CAT directly from the browser over Web Serial. The goal here is
only to stop hand-maintaining the *rig catalogue* — which radios exist, what
they are called, what serial settings they default to — and take it from Hamlib,
which maintains exactly that for ~384 models.

Same three-file discipline as `tools/sync-contests.mjs`:

| File | Role |
| --- | --- |
| `tools/hamlib-sources.json` | Facts from Hamlib, verbatim, pinned to one release tag. Rewritten by `--refresh`. |
| `tools/hamlib-map.json` | The hand-decided part: Hamlib model → WebHam protocol family. Reviewed once, re-applied forever. |
| `js/connectors/rigs-generated.js` | Generated. Never hand-edited. |

```bash
node tools/sync-hamlib.mjs --refresh            # rebuild from the recorded release
node tools/sync-hamlib.mjs --refresh --latest   # move to Hamlib's current release
node tools/sync-hamlib.mjs --build     # snapshot + map -> rigs-generated.js   (offline)
node tools/sync-hamlib.mjs --check     # rebuild and diff; gates commits       (offline)
node tools/sync-hamlib.mjs --report    # print the drift report                (offline)
```

`--refresh` reads `include/hamlib/riglist.h` (for `RIG_MODEL_*` → model number)
and every `.c` file listed in each backend's `Makefile.am` (for the `rig_caps`
structs). Pinned to a tag, so a refresh is reproducible and bumping the version
is a deliberate, reviewable act.

## What Hamlib can and cannot give us

**Identity, cleanly:** model number, model name, manufacturer, port type, and
default serial line settings. All data in `struct rig_caps`.

**The command vocabulary, also cleanly.** This section used to say the CAT
protocol "cannot" be imported because it is C functions rather than data. That
was half right, and the wrong half mattered. The *transaction layer* is control
flow — VFO resolution, redundant-set suppression, response validation, retries,
per-rig quirks and sleeps — and no import touches it. But the *vocabulary* is
literal data in the C source:

| What | Where | Used for |
| --- | --- | --- |
| 41 CI-V command opcodes, the mode codes, the frame constants | `rigs/icom/icom_defs.h` `#define`s | verifying every Icom opcode and frame byte |
| Per-Icom CI-V bus address and `civ_731_mode` | `icom_priv_caps` positional initialisers | **imported** — each Icom profile carries its own address |
| Every Yaesu 5-byte frame | `rigs/yaesu/ft897.c` `ncmd[]` | verifying all five 5-byte opcodes and the mode codes |
| The Kenwood `MD` digit table | `rigs/kenwood/kenwood.c` | verifying Kenwood and Elecraft mode codes |
| The newcat `MD` character table | `rigs/yaesu/newcat.c` | verifying Yaesu ASCII mode codes |
| The command strings each operation sends | string literals inside the `*_set_freq` / `_set_mode` / `_set_ptt` functions | verifying WebHam's ASCII commands |

`--refresh` extracts all of it into the snapshot's `vocabulary`, and
`--diff` compares it field by field against what `cat.js` actually ships. That
comparison is what found the Icom mode table sitting one code high, Yaesu ASCII
PTT never keying the radio, and every Icom being addressed to a controller
instead of a radio. See [the diff](#the-diff-what-disagrees-with-hamlib).

A rig is still only emitted when the map says WebHam has a protocol family that
can actually drive it. Everything else is reported, never guessed — a name in the
picker that fails on connect is worse than an absent one.

**Nothing is overwritten automatically.** WebHam's CAT tables were written by
hand and most of them are right; Hamlib is a second opinion, not a patch. Values
that agree are kept and cost no attention. Values that disagree are classified
and adjudicated in `tools/hamlib-decisions.json`. An automated import must never
silently change a baud rate or a mode byte someone confirmed on hardware.

## The load-bearing detail: keyed by token, never by number

Hamlib model numbers are `MAX_MODELS_PER_BACKEND * backend + index`, so the
FT-897 is `1 * 1000 + 23` = **1023** — which is already WebHam's id for it. That
agreement is what made this import look trivial.

It is not. **22 of WebHam's ids point at a different radio than Hamlib's same
number.** The catalogue was evidently numbered by walking a hand-ordered list,
which lines up with Hamlib in places and drifts elsewhere:

| id | WebHam says | Hamlib says |
| --- | --- | --- |
| 1009 | Yaesu FT-840 | Yaesu FT-767GX |
| 1011 | Yaesu FT-900 | Yaesu FT-840 |
| 1024 | Yaesu FT-817ND | Yaesu FT-1000MP |
| 2010 | Kenwood TS-850 | Kenwood TS-870S |
| 3071 | Icom IC-7200 | Icom ID-5100 |

The 1024 row is the dangerous kind: WebHam's FT-817ND is `yaesu-5byte` (binary
CAT, 4800 8N2) while Hamlib's FT-1000MP is ASCII at a different rate. Keying the
map by model number would therefore pair one rig's protocol family with another
rig's name and serial settings — the wrong bytes, at the wrong baud, to a real
radio.

Everything in `hamlib-map.json` is consequently keyed by the `RIG_MODEL_*`
**token**, which is stable identity; the number is derived from it.
`test-hamlib-sync.mjs` asserts that every emitted rig's id, name, family and
serial all descend from the same token, and that guard is mutation-tested against
exactly the number-keyed mistake.

## What the import found

Run `--report` for the live version. As of Hamlib 4.6.2:

- **196** rigs parsed from the four backends WebHam has protocols for
  (yaesu/kenwood/icom/flexradio), out of 384 models Hamlib declares.
- **80** of WebHam's 107 serial profiles matched a Hamlib rig by name and are
  emitted from Hamlib data.
- **22** had their id changed → `hamlib-map.json`'s `migration.ids`, applied once
  to `localStorage` by `cat.js`.
- **27** unmatched, now carried as `wh:`-namespaced extras (see `extras` and
  `unresolvedNotes` in the map).
- **116** Hamlib rigs skipped, nearly all "no family mapped" — i.e. **available
  to add** once someone assigns a family.
- **2** parse gaps, reported not swallowed: `kenwood/flex6xxx.c` (`thetis_caps`,
  no `model_name`) and `icom/ic785x.c` (`ic785x_caps`, no `rig_model`).

### Pre-existing bugs this surfaced

These are problems in the **current** hand-written catalogue, independent of the
import:

1. **14 profiles are mapped to a protocol their radio does not speak.** Every
   AOR, JRC, Ten-Tec, Alinco and Barrett entry in `cat.js` is
   `kenwood-ascii`. An AOR AR8600 is not a Kenwood; these very likely do not work
   today. They should be dropped, or given a real protocol implementation.
2. **4 ids are not Hamlib model numbers at all**, despite the catalogue otherwise
   following that scheme: `1008` (FT-767GX), `1012` (FT-920), `1031` (FTDX-9000D),
   and `2514` (SmartSDR — Hamlib's SmartSDR models are 23005–23012).
3. **2 rigs are configured outside the rate range Hamlib says they support:**
   the Vertex Standard VX-1700 and Yaesu FT-600 are both set to 38400 in
   `yaesu-ascii-modern`, while Hamlib says both are 4800-only. Worth checking
   against hardware.
4. **21 `stopBits` disagreements**, all `yaesu-ascii-modern` rigs where WebHam
   says 1 and Hamlib says 2. Since these share one family default, this is a
   single decision rather than 21 — but it needs a radio to settle.

## Decided

1. **Hamlib numbering is adopted.** `migration.ids` is applied to `localStorage`
   exactly once, behind a schema marker — see "The one-time migration" below.
2. **Refresh cadence**: `.github/workflows/hamlib-refresh.yml` runs monthly (and
   on demand), refreshes against Hamlib's current release, and opens a PR when
   anything drifts. It never pushes to a default branch — rig data decides what
   bytes reach a radio, so every change gets reviewed.

## Still open

Each needs hardware or an owner call.

1. **The 14 wrongly-mapped rigs** — drop them, or implement their protocols?
   Every AOR/JRC/Ten-Tec/Alinco/Barrett profile claims `kenwood-ascii`.
2. **The `yaesu-ascii-modern` stopBits question**, and the VX-1700 / FT-600 rates.
3. **How many of the 116 available rigs to add**, and who assigns their families.
   Nothing is blocking them technically: they parse fine and are reported by
   `--report`; they simply have no protocol family, and guessing one is the
   thing this pipeline refuses to do.

## The one-time migration

`RIG_ID_MIGRATION` is a remapping, **not** a fixed point: `1008 -> 1009` sits
alongside `1009 -> 1011`, and `1015 -> 1024` alongside
`1024 -> wh:yaesu-ft-817nd`. Feeding it its own output walks an operator down
that chain onto a different radio.

It therefore cannot be applied on read — `persistCatSettings` writes the active
(already-migrated) id back to the same key, so the next boot would migrate a
second time. `cat.js` instead rewrites storage once, guarded by
`web-ham-logger.cat-settings.rigIdSchema`, covering both the stored `profileId`
and the `.overrides` blob's own copy of it (left stale, an operator's confirmed
baud rate silently stops applying).

`test-rig-migration.mjs` boots the real module twice against a stub store to
prove the second pass is a no-op, and is mutation-tested against migrating on
read, dropping the marker, and forgetting the overrides blob.

## Fixed along the way: Icom CI-V mode codes

`icom-civ-modern` had every mode code one too high (`LSB`..`FM` as `01`..`06`).
Mode values are raw CI-V codes — `setMode` does `Number.parseInt(val, 16)` and
sends the result as the data byte of command `0x06` — and Hamlib's
`rigs/icom/icom_defs.h` fixes them for the whole Icom line at `S_LSB 0x00`,
`S_USB 0x01`, `S_AM 0x02`, `S_CW 0x03`, `S_RTTY 0x04`, `S_FM 0x05`,
`S_DSTAR 0x17`.

So an IC-7300 asked for USB was sent `0x02` and went to **AM**; CW went to RTTY;
FM went to Wide FM. `DV` was already correct at `0x17`, which is what gives the
off-by-one away — the table was meant to hold raw CI-V codes all along.
Affected the IC-7100 / 7200 / 7300 / 7610 / 9700 / 705. `test-cat-codecs.mjs`
now pins both Icom families against the Hamlib constants.

## The diff: what disagrees with Hamlib

`node tools/sync-hamlib.mjs --diff` compares **every** WebHam CAT value against
Hamlib's, one field at a time. The engine is `tools/hamlib-diff.mjs`.

The premise is that WebHam's hand-written tables are mostly right, so the job is
not to replace them — it is to find out which ones differ and rule on each.
Every field lands in one of five verdicts:

| Verdict | Meaning | Action |
| --- | --- | --- |
| `agrees` | same value | keep WebHam's, record nothing |
| `diverges` | both have a value, they differ | decide |
| `webham-only` | Hamlib's authority has no counterpart | decide |
| `hamlib-only` | Hamlib knows something WebHam does not offer | decide |
| `unverifiable` | no upstream authority exists, with a reason | decide |

**390 of 445 fields agree.** Those cost no attention, which is the point. The
other 55 each have a line in `tools/hamlib-decisions.json` recording the call —
`keep-webham`, `webham-extra`, `coverage`, or `parked` (which requires a
`followup`). `--diff` exits non-zero if any disagreement has no decision, so
there are only ever two honest responses to one: change the value so it agrees,
or write down why it stays.

The ledger is deliberately not a suppression list. Each entry stores the verdict
it was written against, so a decision cannot keep coasting once the verdict
changes — if Hamlib later adds a mode code WebHam was excused for lacking, the
entry stops excusing anything and `--diff` says so. Entries that no longer match
a live finding are reported as stale, because an unpruned ledger lies about what
is outstanding. A key ending `/*` covers a whole prefix, so one decision about
per-rig CI-V addresses does not need re-editing every time Hamlib adds an Icom.

### What it found on the first run

Kept, because they were already correct: all five CI-V opcodes, all five Yaesu
5-byte frames, all six Kenwood ASCII commands, both CI-V frame bytes, and every
mode code in six of the nine families.

Fixed, because they were not:

- **Yaesu ASCII PTT never keyed the radio.** WebHam sent `TX;` / `RX;`, which is
  Kenwood. `newcat_set_ptt` sends `TX1;` / `TX0;` — on a newcat rig `TX;` is the
  command that *reads* TX status and `RX;` is not a command at all. So PTT over
  CAT polled the radio and returned, on every FT-450/950/991/891/FTDX.
- **Yaesu ASCII mode polling never worked either.** WebHam sent `MD;`;
  `newcat_get_mode` sends `MD%c%c` — `MD`, a VFO digit, then the terminator — and
  a newcat rig answers a bare `MD;` with `?;`.
- **Newcat replies were decoded with the Kenwood table**, which agrees only up to
  CW-R. Added `decodeNewcatMode`; newcat puts PKTLSB on `8` where Kenwood has
  TUNE, and has `A`–`F` where Kenwood has nothing.
- **Every Icom was addressed to a controller.** The CI-V fallback address was
  `0xE0`, which `icom_defs.h` defines as `CTRLID` — the *controller's* address.
  Nothing ever set `profile.civAddr`, so no Icom answered anything until the
  operator typed the address in by hand. Per-rig `re_civ_addr` is now imported
  for 20 rigs; the fallback is `BCASTID`.
- **Kenwood mode digit 8 decoded as "PKT".** Upstream marks it `RIG_MODE_NONE`
  ("TUNE mode or PKTUSB for SDRUNO"), so it named a mode the radio was not in.
- **`civ_731_mode` rigs take an 8-digit frequency frame**, not 10.
- **The Ten-Tec Delta II was mapped to `kenwood-ascii`** while Hamlib implements
  it in `rigs/icom/delta2.c` with a full `icom_priv_caps` (CI-V address `0x01`,
  731 mode, 1200 baud only). That profile could not have worked. Found by a new
  `--build` check: any rig Hamlib gives `icom_priv_caps` for must be mapped to a
  family that speaks CI-V, and `--build` now refuses to write if one is not.

Kept as correct after checking, rather than "fixed" into agreement:

- **`ft897ModeName` decodes `0x06` as WFM** where `ncmd[]` has no WFM row. But
  `ncmd[]` is the *set* table and the FT-897 cannot be set to WFM;
  `ft897_get_mode` has `case 0x06: *mode = RIG_MODE_WFM`. WebHam is right.
- **The CI-V controller address `0xE1`** against Hamlib's `0xE0`. The controller
  address is the sender's own choice, and `0xE1` avoids colliding with a
  Hamlib/flrig instance at `0xE0` on the same shared CI-V bus.
- **Elecraft's `DATA` on digit 6**, which Hamlib canonicalises as `RIG_MODE_RTTY`.
  Same byte, different vendor name.

### Verifying the diff itself

A comparison that reports "everything agrees" is worthless if it would say the
same about a table full of garbage, so `test-hamlib-diff.mjs` mutation-tests every
category: break the value, assert the verdict flips, and assert the clean run does
*not* report it. The same goes for the ledger guards — an unadjudicated finding, a
stale entry, a drifted verdict and a `parked` entry with no `followup` are each
proven to be caught.

Two guards exist because they had to be discovered the hard way:

- **Aliases are per-authority, not global.** `ncmd[]`'s labels are Yaesu's own
  spellings (`DIG`, `PKT`), not Hamlib's `RIG_MODE_*` names. Applying the
  `RIG_MODE_*` map to it reported the FT-897's DIG mode as diverging from itself —
  "WebHam DIG | Hamlib DIG".
- **Every template cites the literal it was derived from**, and the citation is
  checked against the snapshot. Reading `MD%c%c` as "MD, a VFO digit, then the
  terminator" is a human judgement about C semantics; if upstream rewrites that
  literal the citation check fails loudly and forces the reading to be redone,
  rather than letting a stale template keep reporting agreement.

## Not part of this

The three `hamlib-rigctld` profiles and the WebSocket-bridge transport in
`cat.js` are unrelated to this import: they drive a *locally running* rigctld
over a bridge rather than describing a rig. They are untouched here.

## Taking a new Hamlib release

`--refresh` rebuilds from the release recorded in `tools/hamlib-sources.json`
(`hamlibTag`), so it is reproducible: run it twice a month apart and you get the
same output. `--refresh --latest` is the deliberate move to a newer upstream:

```bash
node tools/sync-hamlib.mjs --refresh --latest   # resolve + record the current release
git diff tools/ js/connectors/rigs-generated.js # review what upstream changed
node tools/sync-hamlib.mjs --build              # regenerate the catalogue
node tools/sync-hamlib.mjs --diff               # what now disagrees, and is it decided?
node test-rig-migration.mjs && ./check.sh
```

`--diff` is the step that matters on a version bump: a new upstream release can
change a mode code or a command string, and it exits non-zero until every new
disagreement has been ruled on. `.github/workflows/hamlib-refresh.yml` runs it and
reports the outcome in the PR body — do not merge a refresh on a failing diff.

The current release is read from Hamlib's own SourceForge project
(`best_release.json`), not the GitHub API — no token needed — and the resolved
tag is then probed on the GitHub mirror before use, because a release can be
published there before it is tagged.

Deliberately **not** `master`: master self-reports `5.0.0~git`, i.e. unreleased
and in flux, so tracking it would ship half-finished upstream rig data.

### Known upstream quirk: 4.7.2

A trial run of `--refresh --latest` moved 4.6.2 → **4.7.2** and reported **18
parse gaps**: `rigs/yaesu/Makefile.am` at that tag lists `ftx1*.c`, but those
files are not present in the tagged tree (404), while siblings like `ft710.c`
resolve fine. That is an inconsistency in the 4.7.2 tag itself, not in the
importer — which reported every missing file rather than silently emitting a
smaller catalogue.

This repo therefore stays on **4.6.2** until that is understood; moving up is a
separate, reviewable change. Check the gap count in the refresh output before
accepting any new release.
