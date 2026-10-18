// Exercises the phone pipeline: JPEG photo → base64 → bytes → jpeg-js → analysis.
// Run: npm test  (needs Python 3 + Pillow only to create the JPEG fixtures)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { analyzeImage } from "../src/analysis.js";
import { base64ToBytes } from "../src/base64.js";
import { LIGHTING, renderBandage } from "../src/demo.js";

const dir = mkdtempSync(join(tmpdir(), "cellusense-"));

function toJpegBase64(img, quality = 90) {
  const raw = join(dir, "frame.rgba");
  const out = join(dir, "frame.jpg");
  writeFileSync(raw, img.data);
  execFileSync("python3", [
    "-I",
    "-c",
    `from PIL import Image;import sys;Image.frombytes('RGBA',(${img.width},${img.height}),open(sys.argv[1],'rb').read()).convert('RGB').save(sys.argv[2],quality=${quality})`,
    raw,
    out,
  ]);
  return readFileSync(out).toString("base64");
}

test("base64 decoder matches Node's", () => {
  for (const n of [0, 1, 2, 3, 10, 1000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
    const b64 = Buffer.from(bytes).toString("base64");
    assert.deepEqual(base64ToBytes(b64), bytes);
  }
});

for (const lighting of Object.keys(LIGHTING)) {
  test(`JPEG photo pipeline is accurate under ${LIGHTING[lighting].label}`, () => {
    for (const ph of [5.8, 6.7, 7.8]) {
      const img = renderBandage({ ph, lighting, width: 640, height: 853, r: 640 * 0.3, seed: 5 });
      const d = jpeg.decode(base64ToBytes(toJpegBase64(img)), { useTArray: true, formatAsRGBA: true });
      const res = analyzeImage({ width: d.width, height: d.height, data: d.data }, {
        hint: { cx: d.width / 2, cy: d.height / 2, r: d.width * 0.36 },
      });
      assert.ok(res.ring.found);
      assert.ok(Math.abs(res.ph - ph) < 0.15, `${lighting} pH ${ph} → ${res.ph}`);
    }
  });
}
