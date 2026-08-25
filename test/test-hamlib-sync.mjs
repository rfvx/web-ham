// Unit tests for tools/sync-hamlib.mjs — the Hamlib rig-catalogue importer.
//
// Fully offline: the parsers are pure functions over text, and the catalogue
// build reads the committed snapshot + map. Nothing here touches the network.
import assert from "node:assert";
import { readFile } from "node:fs/promises";

const mod = await import("../tools/sync-hamlib.mjs").catch((e) => {
  // The module runs a CLI on import and exits when given no --flag. Guard so a
  // refactor that breaks the export surface fails loudly here.
  throw new Error(`could not import sync-hamlib.mjs as a module: ${e.message}`);
});
const { parseRigList, parseCapsFile, buildCatalogue } = mod;

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ── riglist.h parsing ────────────────────────────────────────────────────────

const RIGLIST = `
#define MAX_MODELS_PER_BACKEND 1000
#define RIG_MAKE_MODEL(a,b) (MAX_MODELS_PER_BACKEND*(a)+(b))
#define RIG_BACKEND_NUM(a) ((a)/MAX_MODELS_PER_BACKEND)
#define RIG_DUMMY 0
#define RIG_YAESU 1
#define RIG_KENWOOD 2
#define RIG_MODEL_FT897 RIG_MAKE_MODEL(RIG_YAESU, 23)
#define RIG_MODEL_TS2000 RIG_MAKE_MODEL(RIG_KENWOOD, 19)
#define RIG_MODEL_MYSTERY RIG_MAKE_MODEL(RIG_NOSUCHBACKEND, 7)
`;

check("riglist: resolves the documented FT-897 = 1023", () => {
  const { perBackend, models } = parseRigList(RIGLIST);
  assert.strictEqual(perBackend, 1000);
  assert.deepStrictEqual(models.get("RIG_MODEL_FT897"), { id: "1023", backend: "yaesu" });
});

check("riglist: backend offset applies per backend", () => {
  const { models } = parseRigList(RIGLIST);
  assert.deepStrictEqual(models.get("RIG_MODEL_TS2000"), { id: "2019", backend: "kenwood" });
});

// An unknown backend must be reported, not silently folded to 0 — which would
// mint a plausible-looking but wrong low-numbered id.
check("riglist: unknown backend is reported, not guessed", () => {
  const { models, unresolved } = parseRigList(RIGLIST);
  assert.ok(!models.has("RIG_MODEL_MYSTERY"));
  assert.deepStrictEqual(unresolved, [{ name: "RIG_MODEL_MYSTERY", backend: "NOSUCHBACKEND" }]);
});

check("riglist: a missing MAX_MODELS_PER_BACKEND throws", () => {
  assert.throws(() => parseRigList("#define RIG_YAESU 1\n"), /MAX_MODELS_PER_BACKEND/);
});

// ── rig_caps parsing ─────────────────────────────────────────────────────────

// Includes a nested-brace member (the frequency table) because that is exactly
// what defeats a regex-only extractor: a naive match on the closing brace stops
// inside tx_range_list and loses every field after it.
const CAPS = `
struct rig_caps ft897_caps = {
    RIG_MODEL(RIG_MODEL_FT897),
    .model_name =     "FT-897",
    .mfg_name =       "Yaesu",
    .rig_type =       RIG_TYPE_TRANSCEIVER,
    .port_type =      RIG_PORT_SERIAL,
    .serial_rate_min =    4800,
    .serial_rate_max =    38400,
    .serial_data_bits =   8,
    .serial_stop_bits =   2,
    .serial_parity =  RIG_PARITY_NONE,
    .serial_handshake =   RIG_HANDSHAKE_NONE,
    .tx_range_list1 = {
        { .startf = 1800000, .endf = 2000000 },
        { .startf = 3500000, .endf = 4000000 },
        RIG_FRNG_END,
    },
    .priv = NULL,
};

struct rig_caps netrig_caps = {
    .rig_model = RIG_MODEL_TS2000,
    .model_name = "TS-2000",
    .mfg_name = "Kenwood",
    .port_type = RIG_PORT_NETWORK,
    .serial_rate_min = 9600,
    .serial_rate_max = 9600,
    .serial_data_bits = 8,
    .serial_stop_bits = 1,
    .serial_parity = RIG_PARITY_NONE,
    .serial_handshake = RIG_HANDSHAKE_HARDWARE,
};

struct rig_caps broken_caps = {
    .model_name = "No Model Number",
};
`;

check("caps: extracts fields past a nested-brace member", () => {
  const { rigs } = parseCapsFile(CAPS, "yaesu/ft897.c");
  const ft = rigs.find((r) => r.modelToken === "RIG_MODEL_FT897");
  assert.strictEqual(ft.modelName, "FT-897");
  assert.strictEqual(ft.mfgName, "Yaesu");
  assert.strictEqual(ft.portType, "RIG_PORT_SERIAL");
  // .priv sits after tx_range_list1; reading stop_bits proves the brace matcher
  // consumed the nested table rather than ending the struct early.
  assert.strictEqual(ft.serial.stopBits, 2);
  assert.strictEqual(ft.serial.rateMin, 4800);
  assert.strictEqual(ft.serial.rateMax, 38400);
  assert.strictEqual(ft.serial.parity, "none");
});

check("caps: accepts both RIG_MODEL(x) and .rig_model = x", () => {
  const { rigs } = parseCapsFile(CAPS, "x.c");
  assert.ok(rigs.some((r) => r.modelToken === "RIG_MODEL_FT897"));
  assert.ok(rigs.some((r) => r.modelToken === "RIG_MODEL_TS2000"));
});

check("caps: maps Hamlib enums to Web Serial vocabulary", () => {
  const { rigs } = parseCapsFile(CAPS, "x.c");
  const ts = rigs.find((r) => r.modelToken === "RIG_MODEL_TS2000");
  assert.strictEqual(ts.serial.flowControl, "hardware");
  assert.strictEqual(ts.serial.parity, "none");
});

check("caps: a struct with no model number becomes a reported gap", () => {
  const { rigs, gaps } = parseCapsFile(CAPS, "yaesu/ft897.c");
  assert.ok(!rigs.some((r) => r.symbol === "broken_caps"));
  assert.deepStrictEqual(
    gaps.find((g) => g.symbol === "broken_caps"),
    { file: "yaesu/ft897.c", symbol: "broken_caps", reason: "no rig_model" }
  );
});

// ── catalogue build ──────────────────────────────────────────────────────────

const snapshot = {
  hamlibTag: "test",
  parseGaps: [],
  rigs: [
    { id: "1023", modelToken: "RIG_MODEL_FT897", modelName: "FT-897", mfgName: "Yaesu", backend: "yaesu",
      portType: "RIG_PORT_SERIAL", serial: { rateMin: 4800, rateMax: 38400, dataBits: 8, stopBits: 2, parity: "none", flowControl: "none" } },
    { id: "2019", modelToken: "RIG_MODEL_TS2000", modelName: "TS-2000", mfgName: "Kenwood", backend: "kenwood",
      portType: "RIG_PORT_NETWORK", serial: { rateMin: 9600, rateMax: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" } },
    { id: "5011", modelToken: "RIG_MODEL_AR8600", modelName: "AR8600", mfgName: "AOR", backend: "aor",
      portType: "RIG_PORT_SERIAL", serial: { rateMin: 9600, rateMax: 9600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" } },
  ],
};

check("build: emits a mapped serial rig", () => {
  const { emitted } = buildCatalogue(snapshot, { modelFamilies: { RIG_MODEL_FT897: "yaesu-5byte" } });
  assert.strictEqual(emitted.length, 1);
  assert.deepStrictEqual(
    { id: emitted[0].id, family: emitted[0].family, name: emitted[0].name },
    { id: "1023", family: "yaesu-5byte", name: "Yaesu FT-897" }
  );
});

// A rig with no family assigned must never reach the picker: WebHam would open a
// serial port and send bytes from whatever family it defaulted to.
check("build: an unmapped rig is skipped with a reason, not defaulted", () => {
  const { emitted, skipped } = buildCatalogue(snapshot, { modelFamilies: {} });
  assert.strictEqual(emitted.length, 0);
  assert.ok(skipped.every((s) => s.reason));
  assert.ok(skipped.some((s) => s.id === "5011" && /no family mapped/.test(s.reason)));
});

check("build: non-serial rigs are skipped unless explicitly allowed", () => {
  const map = { modelFamilies: { RIG_MODEL_TS2000: "kenwood-ascii" } };
  assert.strictEqual(buildCatalogue(snapshot, map).emitted.length, 0);

  const allowed = { ...map, allowNonSerial: { ids: ["RIG_MODEL_TS2000"] } };
  const { emitted } = buildCatalogue(snapshot, allowed);
  assert.deepStrictEqual([emitted.length, emitted[0].id], [1, "2019"]);
});

check("build: exclude wins over a family mapping", () => {
  const map = { modelFamilies: { RIG_MODEL_FT897: "yaesu-5byte" }, exclude: { ids: ["RIG_MODEL_FT897"] } };
  const { emitted, skipped } = buildCatalogue(snapshot, map);
  assert.strictEqual(emitted.length, 0);
  assert.ok(skipped.some((s) => s.reason === "excluded by map"));
});

// THE regression that matters. Keying the map by model NUMBER instead of token
// pairs one rig's protocol family with another rig's name and serial settings,
// because WebHam and Hamlib disagree about 22 numbers. That means wrong CAT
// bytes at a wrong baud rate to a real radio, so it gets an explicit test.
check("build: family/name/serial always describe the SAME rig", async () => {
  const realSnapshot = JSON.parse(await readFile(new URL("../tools/hamlib-sources.json", import.meta.url), "utf8"));
  const realMap = JSON.parse(await readFile(new URL("../tools/hamlib-map.json", import.meta.url), "utf8"));
  const { emitted } = buildCatalogue(realSnapshot, realMap);
  assert.ok(emitted.length > 50, `expected a populated catalogue, got ${emitted.length}`);
  for (const rig of emitted) {
    if (!rig.hamlib) continue;
    const source = realSnapshot.rigs.find((r) => r.modelToken === rig.hamlib.modelToken);
    assert.ok(source, `${rig.id}: no snapshot rig for ${rig.hamlib.modelToken}`);
    // id, name and serial must all derive from that one token's rig.
    assert.strictEqual(rig.id, source.id, `${rig.id}: id does not match its token's rig`);
    assert.strictEqual(rig.name, `${source.mfgName} ${source.modelName}`.trim());
    assert.strictEqual(rig.family, realMap.modelFamilies[source.modelToken]);
  }
});

// The FT-897 is the anchor: it is the one rig whose number provably agrees
// between WebHam's hand-written catalogue and Hamlib, and it is the default
// profile, so a renumbering bug would show up here first.
check("build: FT-897 stays 1023/yaesu-5byte (the default profile)", async () => {
  const realSnapshot = JSON.parse(await readFile(new URL("../tools/hamlib-sources.json", import.meta.url), "utf8"));
  const realMap = JSON.parse(await readFile(new URL("../tools/hamlib-map.json", import.meta.url), "utf8"));
  const { emitted } = buildCatalogue(realSnapshot, realMap);
  const ft897 = emitted.find((r) => r.hamlib?.modelToken === "RIG_MODEL_FT897");
  assert.ok(ft897, "FT-897 missing from the generated catalogue");
  assert.strictEqual(ft897.id, "1023");
  assert.strictEqual(ft897.family, "yaesu-5byte");
});

// ── migration table ──────────────────────────────────────────────────────────

// Two kinds of target now: a Hamlib model number (the 22 renumbered rigs) or a
// namespaced "wh:" id (the 27 WebHam-only profiles that were moved off numeric
// ids so they could never sit on a real Hamlib model). Both must resolve.
check("map: every migration entry lands on something the catalogue defines", async () => {
  const realSnapshot = JSON.parse(await readFile(new URL("../tools/hamlib-sources.json", import.meta.url), "utf8"));
  const realMap = JSON.parse(await readFile(new URL("../tools/hamlib-map.json", import.meta.url), "utf8"));
  const byId = new Map(realSnapshot.rigs.map((r) => [r.id, r]));
  const entries = Object.entries(realMap.migration.ids);
  assert.ok(entries.length > 0, "expected a non-empty migration table");

  let hamlibTargets = 0;
  let extraTargets = 0;
  for (const [from, to] of entries) {
    assert.notStrictEqual(from, to.to, `${from}: migration to itself is meaningless`);

    if (to.to.startsWith("wh:")) {
      const extra = realMap.extras.profiles[to.to];
      assert.ok(extra, `${from} -> ${to.to}: no such WebHam-only profile`);
      assert.strictEqual(extra.wasId, from, `${from} -> ${to.to}: extra records wasId ${extra.wasId}`);
      extraTargets += 1;
      continue;
    }

    const target = byId.get(to.to);
    assert.ok(target, `${from} -> ${to.to}: target is not a Hamlib rig`);
    assert.strictEqual(target.modelToken, to.token, `${from} -> ${to.to}: token disagrees with target`);
    hamlibTargets += 1;
  }
  assert.ok(hamlibTargets > 0 && extraTargets > 0, "expected both kinds of migration target");
});

// The namespacing exists to prevent exactly this: a WebHam-only profile sitting
// on a model number Hamlib also uses. Four of them did before the move.
check("map: no WebHam-only extra occupies a Hamlib model number", async () => {
  const realSnapshot = JSON.parse(await readFile(new URL("../tools/hamlib-sources.json", import.meta.url), "utf8"));
  const realMap = JSON.parse(await readFile(new URL("../tools/hamlib-map.json", import.meta.url), "utf8"));
  const hamlibIds = new Set(realSnapshot.rigs.map((r) => r.id));
  for (const id of Object.keys(realMap.extras.profiles)) {
    assert.ok(id.startsWith("wh:"), `extra "${id}" is not namespaced`);
    assert.ok(!hamlibIds.has(id), `extra "${id}" collides with a Hamlib model number`);
  }
});

process.stdout.write(`\nhamlib-sync: ${passed} assertions passed\n`);
