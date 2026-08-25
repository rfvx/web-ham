// worker.js routes /api/* by hand, because the Workers runtime has no
// equivalent of the Pages functions/ directory convention. That hand-written
// table is the one place the two deploy targets can silently disagree: add an
// endpoint under functions/api/ and forget worker.js, and it works on Pages and
// 404s on Workers — or the reverse.
//
// So this derives the expected table from the directory and compares.
import assert from "node:assert";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = join(ROOT, "functions", "api");

const { ROUTES } = await import(pathToFileURL(join(ROOT, "worker.js")));

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// Walk functions/api/ the way Pages does: every .js file is an endpoint at its
// path, minus the extension. Files starting with "_" are not routed, and
// [[path]].js is the catch-all rather than a route of its own.
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith(".js") && !entry.name.startsWith("_")) {
      out.push(full);
    }
  }
  return out;
}

const files = (await walk(API_DIR)).sort();
const expected = new Map();
for (const file of files) {
  const rel = relative(API_DIR, file).replace(/\\/g, "/");
  if (rel === "[[path]].js") continue;
  const module = await import(pathToFileURL(file));
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
    (m) => typeof module[`onRequest${m[0]}${m.slice(1).toLowerCase()}`] === "function"
  );
  expected.set(`/api/${rel.replace(/\.js$/, "")}`, methods);
}

await check("every functions/api endpoint has a worker.js route", () => {
  const missing = [...expected.keys()].filter((p) => !ROUTES[p]);
  assert.deepStrictEqual(missing, [], `not routed in worker.js: ${missing.join(", ")}`);
});

await check("worker.js routes nothing that functions/api does not define", () => {
  const extra = Object.keys(ROUTES).filter((p) => !expected.has(p));
  assert.deepStrictEqual(extra, [], `routed but no such endpoint: ${extra.join(", ")}`);
});

await check("each route exposes exactly the methods its module exports", () => {
  for (const [path, methods] of expected) {
    assert.deepStrictEqual(
      Object.keys(ROUTES[path]).sort(),
      [...methods].sort(),
      `${path}: worker.js methods disagree with the module's exports`
    );
  }
});

await check("every routed handler is actually a function", () => {
  for (const [path, methods] of Object.entries(ROUTES)) {
    for (const [method, handler] of Object.entries(methods)) {
      assert.strictEqual(typeof handler, "function", `${method} ${path} is not a function`);
    }
  }
});

// The catch-all is what turns an unknown /api path into JSON instead of the
// static 404 page. worker.js has to reach it explicitly; Pages does it by
// convention.
await check("the catch-all exists and worker.js imports it", async () => {
  const module = await import(pathToFileURL(join(API_DIR, "[[path]].js")));
  assert.strictEqual(typeof module.onRequest, "function");
});

await check("the five known endpoints are all present", () => {
  for (const path of [
    "/api/time",
    "/api/callsign",
    "/api/tle",
    "/api/lotw/download",
    "/api/lotw/sign-upload",
  ]) {
    assert.ok(ROUTES[path], `${path} missing from worker.js`);
  }
});

process.stdout.write(`worker-routes: ${passed} assertions passed\n`);
