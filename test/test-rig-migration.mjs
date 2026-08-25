// The rig catalogue moved to Hamlib's model numbers, which renumbered 22 rigs
// and pushed 27 WebHam-only profiles onto namespaced "wh:" ids. Anyone with a
// saved CAT profile has one of the OLD ids in localStorage.
//
// This suite guards the property that actually reaches hardware: every id an
// operator could have saved must still resolve, and must still resolve to a
// profile that speaks the SAME protocol at the SAME serial settings. Getting
// this wrong doesn't throw — it quietly drives a radio with another radio's
// protocol. Run: node test-rig-migration.mjs
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { RADIO_PROFILES, RADIO_FAMILIES, migrateProfileId, migrateStoredRigIds } from "../js/connectors/cat.js";
import { RIG_ID_MIGRATION } from "../js/connectors/rigs-generated.js";

const before = JSON.parse(await readFile(new URL("../tools/rig-catalogue-pre-hamlib.json", import.meta.url), "utf8")).profiles;

// Minimal localStorage stand-in so the one-time migration can be driven
// directly, including the paths a real browser only reaches once.
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ── the safety property ──────────────────────────────────────────────────────

await check("every pre-migration id still resolves to a profile", () => {
  for (const oldId of Object.keys(before)) {
    const resolved = RADIO_PROFILES[migrateProfileId(oldId)];
    assert.ok(resolved, `saved profileId ${oldId} (${before[oldId].name}) no longer resolves`);
  }
});

// Deliberate protocol corrections: rigs whose ORIGINAL family was wrong, so
// preserving it would preserve a profile that cannot drive the radio. Each needs a
// reason, and the assertion below still checks that the new protocol is the one
// named here — the exemption narrows the invariant, it does not remove it.
const CORRECTED_PROTOCOL = {
  // Found by tools/sync-hamlib.mjs --build's civFamilies check. Ten-Tec licensed
  // Icom's CI-V for the Delta II and Hamlib implements it in rigs/icom/delta2.c
  // with a full icom_priv_caps (address 0x01, civ_731_mode, 1200 baud only). As
  // kenwood-ascii it sent `FA…;` ASCII at 19200 to a radio speaking CI-V binary at
  // 1200, so nothing about that profile worked. Keeping the old protocol here would
  // be keeping the bug.
  "16003": { was: "kenwood-ascii", now: "icom-civ", rig: "Ten-Tec Delta II" },
};

// THE one that matters. A renumbering that lands an operator on a profile with a
// different protocol sends the wrong bytes at the wrong baud rate. Compared
// against the family recorded in the pre-migration fixture — not against the
// resolved profile itself, which would be a tautology that always passes.
await check("migration never changes a rig's protocol, except where it was wrong", () => {
  for (const [oldId, old] of Object.entries(before)) {
    if (old.family === null) continue; // "No Radio" is a literal, not a family
    const expected = RADIO_FAMILIES[old.family];
    assert.ok(expected, `fixture names family "${old.family}" which no longer exists`);
    const resolved = RADIO_PROFILES[migrateProfileId(oldId)];
    const correction = CORRECTED_PROTOCOL[oldId];
    if (correction) {
      assert.strictEqual(correction.was, expected.protocol, `${oldId}: correction records the wrong old protocol`);
      assert.strictEqual(
        resolved.protocol, correction.now,
        `${oldId} (${correction.rig}) is a recorded correction to ${correction.now}, but resolves to ${resolved.protocol}`
      );
      continue;
    }
    assert.strictEqual(
      resolved.protocol,
      expected.protocol,
      `${oldId} (${old.name}) was ${expected.protocol}, now resolves to ${resolved.protocol}` +
      ` — if that is a deliberate correction, add it to CORRECTED_PROTOCOL with a reason`
    );
  }
});

await check("every recorded protocol correction is still needed", () => {
  // An exemption for a rig that no longer changes protocol is an exemption that
  // would silently excuse the next real regression on that id.
  for (const [oldId, correction] of Object.entries(CORRECTED_PROTOCOL)) {
    const old = before[oldId];
    assert.ok(old, `CORRECTED_PROTOCOL names ${oldId}, which is not in the pre-migration fixture`);
    assert.notStrictEqual(
      RADIO_FAMILIES[old.family].protocol, correction.now,
      `${oldId} no longer changes protocol — remove it from CORRECTED_PROTOCOL`
    );
  }
});

// Names are compared as an unordered token set, because adopting Hamlib means
// adopting its spelling too: it calls the MARK-V "Yaesu MARK-V FT-1000MP" where
// WebHam wrote "Yaesu FT-1000MP MARK-V". Same tokens = same radio; a genuine
// mis-migration (FT-840 -> FT-767GX) still fails loudly.
const tokens = (name) => name.toUpperCase().split(/[\s-]+/).filter(Boolean).sort().join(" ");

await check("migration never changes which radio a saved id names", () => {
  for (const [oldId, old] of Object.entries(before)) {
    const resolved = RADIO_PROFILES[migrateProfileId(oldId)];
    assert.strictEqual(
      tokens(resolved.name),
      tokens(old.name),
      `saved profileId ${oldId} used to be "${old.name}" but now resolves to "${resolved.name}"`
    );
  }
});

// ── the swap hazard ──────────────────────────────────────────────────────────

// RIG_ID_MIGRATION contains swaps: WebHam's FT-1000MP takes the number its
// FT-817ND used to hold. Applying the table to its own output would walk the
// FT-1000MP owner onto the FT-817ND — a different protocol family entirely.
await check("the FT-1000MP / FT-817ND swap is present and resolves correctly", () => {
  assert.strictEqual(migrateProfileId("1015"), "1024");
  assert.strictEqual(migrateProfileId("1024"), "wh:yaesu-ft-817nd");
  assert.strictEqual(RADIO_PROFILES["1024"].name, "Yaesu FT-1000MP");
  assert.strictEqual(RADIO_PROFILES["wh:yaesu-ft-817nd"].name, "Yaesu FT-817ND");
  // and they are genuinely different protocols, which is why the order matters
  assert.notStrictEqual(
    RADIO_PROFILES["1024"].protocol,
    RADIO_PROFILES["wh:yaesu-ft-817nd"].protocol
  );
});

// The table is deliberately NOT a fixed point — "1008" -> "1009" sits alongside
// "1009" -> "1011" — so applying it twice walks an operator onto a different
// radio. That is why the migration rewrites storage once behind a schema marker
// instead of mapping on read. This runs the real migration twice over a stub
// store and proves the second pass is a no-op.
await check("running the storage migration twice is a no-op (exactly-once marker)", () => {
  for (const [oldId, old] of Object.entries(before)) {
    const store = makeStore({
      "web-ham-logger.cat-settings.profile": oldId,
      "web-ham-logger.cat-settings.overrides": JSON.stringify({ profileId: oldId, baudRate: 19200 }),
    });

    assert.strictEqual(migrateStoredRigIds(store), true, `${oldId}: first pass should migrate`);
    const afterFirst = store.getItem("web-ham-logger.cat-settings.profile");

    assert.strictEqual(migrateStoredRigIds(store), false, `${oldId}: second pass should be skipped`);
    assert.strictEqual(
      store.getItem("web-ham-logger.cat-settings.profile"),
      afterFirst,
      `${oldId} (${old.name}) moved again on a second migration pass`
    );

    // and it landed on the right rig
    assert.strictEqual(afterFirst, migrateProfileId(oldId));
    assert.strictEqual(tokens(RADIO_PROFILES[afterFirst].name), tokens(old.name));

    // the overrides blob followed the profile, so saved serial settings still apply
    const overrides = JSON.parse(store.getItem("web-ham-logger.cat-settings.overrides"));
    assert.strictEqual(overrides.profileId, afterFirst, `${oldId}: overrides blob left behind`);
    assert.strictEqual(overrides.baudRate, 19200, `${oldId}: overrides content mangled`);
  }
});

// The specific chain the marker exists to prevent.
await check("the 1008 -> 1009 -> 1011 chain cannot happen", () => {
  const store = makeStore({ "web-ham-logger.cat-settings.profile": "1008" });
  migrateStoredRigIds(store);
  migrateStoredRigIds(store);
  migrateStoredRigIds(store);
  const landed = store.getItem("web-ham-logger.cat-settings.profile");
  assert.strictEqual(landed, "1009", "FT-767GX should stop at 1009, not walk on to 1011");
  assert.strictEqual(tokens(RADIO_PROFILES[landed].name), tokens("Yaesu FT-767GX"));
});

await check("a store already on the current schema is left alone", () => {
  const store = makeStore({
    "web-ham-logger.cat-settings.profile": "1008",
    "web-ham-logger.cat-settings.rigIdSchema": "hamlib-1",
  });
  assert.strictEqual(migrateStoredRigIds(store), false);
  assert.strictEqual(store.getItem("web-ham-logger.cat-settings.profile"), "1008");
});

await check("migration survives a missing or corrupt overrides blob", () => {
  const noOverrides = makeStore({ "web-ham-logger.cat-settings.profile": "1015" });
  assert.strictEqual(migrateStoredRigIds(noOverrides), true);
  assert.strictEqual(noOverrides.getItem("web-ham-logger.cat-settings.profile"), "1024");

  const corrupt = makeStore({
    "web-ham-logger.cat-settings.profile": "1015",
    "web-ham-logger.cat-settings.overrides": "{not json",
  });
  // Must not throw, and must not half-migrate: the marker is only written on a
  // clean pass, so a later run can still fix it.
  assert.doesNotThrow(() => migrateStoredRigIds(corrupt));
  assert.strictEqual(corrupt.getItem("web-ham-logger.cat-settings.rigIdSchema"), null);
});

// ── table hygiene ────────────────────────────────────────────────────────────

await check("every migration target exists in the catalogue", () => {
  for (const [from, to] of Object.entries(RIG_ID_MIGRATION)) {
    assert.ok(RADIO_PROFILES[to], `${from} -> ${to}, but ${to} is not a profile`);
  }
});

await check("no entry maps an id to itself", () => {
  for (const [from, to] of Object.entries(RIG_ID_MIGRATION)) {
    assert.notStrictEqual(from, to, `${from} maps to itself — dead entry`);
  }
});

await check("every migration source is a real pre-migration id", () => {
  for (const from of Object.keys(RIG_ID_MIGRATION)) {
    assert.ok(before[from], `${from} is migrated but was never in the old catalogue`);
  }
});

// ── things that must NOT have moved ──────────────────────────────────────────

await check("the rigctld profiles and No Radio keep their ids", () => {
  for (const id of ["0", "1", "2", "4"]) {
    assert.strictEqual(migrateProfileId(id), id);
    assert.ok(RADIO_PROFILES[id], `${id} missing from the catalogue`);
  }
});

// The default profile every fresh install starts on.
await check("the FT-897 default is untouched at 1023", () => {
  assert.strictEqual(migrateProfileId("1023"), "1023");
  assert.strictEqual(RADIO_PROFILES["1023"].name, "Yaesu FT-897");
  assert.strictEqual(RADIO_PROFILES["1023"].protocol, "yaesu-5byte");
});

await check("an unknown id passes through untouched", () => {
  assert.strictEqual(migrateProfileId("not-a-rig"), "not-a-rig");
  assert.strictEqual(migrateProfileId(""), "");
});

// ── catalogue shape ──────────────────────────────────────────────────────────

await check("the catalogue is a superset of what shipped before", () => {
  assert.ok(
    Object.keys(RADIO_PROFILES).length >= Object.keys(before).length,
    "the catalogue lost profiles"
  );
});

await check("no two profiles share an id, and every profile carries its own id", () => {
  for (const [id, profile] of Object.entries(RADIO_PROFILES)) {
    assert.strictEqual(profile.id, id, `profile keyed ${id} carries id ${profile.id}`);
  }
});

await check("every generated profile resolved a real protocol family", () => {
  for (const [id, profile] of Object.entries(RADIO_PROFILES)) {
    assert.ok(profile.protocol, `${id} (${profile.name}) has no protocol`);
    assert.ok(profile.serial, `${id} (${profile.name}) has no serial settings`);
  }
});

// ── the real boot path ───────────────────────────────────────────────────────

// Everything above drives migrateStoredRigIds() directly, which does NOT prove
// the module is wired to call it — a build that dropped the call and migrated on
// read instead would still pass. That build is the dangerous one: cat.js
// persists the active (already-migrated) id back to the same key, so the next
// boot migrates a second time and walks the operator down the chain.
//
// So boot the module for real, twice, with a cache-busting query so the second
// import re-evaluates instead of returning the cached instance.
async function boot(store, n) {
  globalThis.localStorage = store;
  return import(`../js/connectors/cat.js?boot=${n}`);
}

const PROFILE_KEY = "web-ham-logger.cat-settings.profile";

await check("boot migrates stored ids, and a second boot does not move them again", async () => {
  const store = makeStore({ [PROFILE_KEY]: "1008" });          // FT-767GX, old id

  await boot(store, "a1");
  assert.strictEqual(store.getItem(PROFILE_KEY), "1009", "first boot should renumber 1008 -> 1009");

  // Simulate what persistCatSettings does after any settings save: write the
  // now-active id straight back to the same key.
  store.setItem(PROFILE_KEY, store.getItem(PROFILE_KEY));

  await boot(store, "a2");
  assert.strictEqual(
    store.getItem(PROFILE_KEY),
    "1009",
    "second boot re-migrated: FT-767GX walked on to 1011 (FT-840)"
  );
});

await check("boot handles the FT-1000MP swap across a restart", async () => {
  const store = makeStore({ [PROFILE_KEY]: "1015" });          // FT-1000MP, old id
  await boot(store, "b1");
  assert.strictEqual(store.getItem(PROFILE_KEY), "1024");
  await boot(store, "b2");
  assert.strictEqual(
    store.getItem(PROFILE_KEY),
    "1024",
    "second boot walked the FT-1000MP onto the FT-817ND"
  );
});

await check("a fresh install is untouched and lands on the FT-897 default", async () => {
  const store = makeStore({});
  const mod = await boot(store, "c1");
  assert.strictEqual(mod.cat.getProfileId(), "1023");
  assert.strictEqual(store.getItem(PROFILE_KEY), null, "nothing to migrate, nothing written");
});

process.stdout.write(`\nrig-migration: ${passed} assertions passed\n`);
