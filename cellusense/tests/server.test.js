import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  proc = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT) },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 8000);
    proc.stdout.on("data", d => {
      if (String(d).includes("Local")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", c => reject(new Error(`exited ${c}`)));
  });
});
after(() => proc?.kill());

test("serves every file the service worker precaches", async () => {
  const sw = await (await fetch(`${BASE}/sw.js`)).text();
  const assets = JSON.parse(sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"));
  for (const a of assets) {
    const res = await fetch(`${BASE}/${a === "./" ? "" : a}`);
    assert.equal(res.status, 200, a);
  }
});

test("uses correct MIME types for modules and manifest", async () => {
  assert.match((await fetch(`${BASE}/js/app.js`)).headers.get("content-type"), /javascript/);
  assert.match((await fetch(`${BASE}/manifest.webmanifest`)).headers.get("content-type"), /manifest\+json/);
});

test("blocks traversal and private files", async () => {
  assert.equal((await fetch(`${BASE}/..%2f..%2fetc/passwd`)).status, 404);
  assert.equal((await fetch(`${BASE}/package.json`)).status, 404);
  assert.equal((await fetch(`${BASE}/tests/server.test.js`)).status, 404);
});
