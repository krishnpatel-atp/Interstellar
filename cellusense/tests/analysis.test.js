import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_CURVE,
  analyzeImage,
  classifyRisk,
  detectRing,
  indicatorColor,
  ratioToPh,
  recommendations,
  trendAlerts,
  validateCurve,
} from "../js/analysis.js";
import { LIGHTING, renderBandage } from "../js/demo.js";

describe("pH ↔ R/G calibration", () => {
  test("default curve is valid and monotonic", () => {
    assert.equal(validateCurve(DEFAULT_CURVE), null);
  });

  test("curve points map back to their own pH", () => {
    for (const p of DEFAULT_CURVE) {
      assert.ok(Math.abs(ratioToPh(p.ratio).ph - p.ph) < 1e-9, `pH ${p.ph}`);
    }
  });

  test("the indicator colour's R/G maps back to the same pH", () => {
    for (let ph = 5; ph <= 9; ph += 0.1) {
      const [r, g] = indicatorColor(ph);
      assert.ok(Math.abs(ratioToPh(r / g).ph - ph) < 0.05, `pH ${ph.toFixed(1)}`);
    }
  });

  test("out-of-range ratios are clamped and flagged", () => {
    assert.equal(ratioToPh(99).inRange, false);
    assert.ok(ratioToPh(99).ph >= 4);
    assert.ok(ratioToPh(0.01).ph <= 10);
    assert.ok(Number.isNaN(ratioToPh(Number.NaN).ph));
  });

  test("invalid curves are rejected", () => {
    assert.ok(validateCurve([{ ph: 5, ratio: 2 }]));
    assert.ok(
      validateCurve([
        { ph: 5, ratio: 1 },
        { ph: 6, ratio: 2 },
      ]),
    );
    assert.ok(
      validateCurve([
        { ph: 5, ratio: 2 },
        { ph: 5, ratio: 1 },
      ]),
    );
    assert.ok(
      validateCurve([
        { ph: 5, ratio: -1 },
        { ph: 6, ratio: 1 },
      ]),
    );
  });
});

describe("risk scoring", () => {
  const cases = [
    [4.8, "low"],
    [5.5, "low"],
    [6.2, "low"],
    [6.24, "low"],
    [6.25, "observation"],
    [6.3, "observation"],
    [7.2, "observation"],
    [7.24, "observation"],
    [7.25, "high"],
    [7.3, "high"],
    [8.4, "high"],
  ];
  for (const [ph, zone] of cases) {
    test(`pH ${ph} → ${zone}`, () => assert.equal(classifyRisk(ph).id, zone));
  }

  test("recommendations match zones", () => {
    assert.match(recommendations(7.8).headline, /Alert care team/);
    assert.match(recommendations(6.8).headline, /Clean wound site/);
    assert.match(recommendations(5.9).headline, /routine/);
    assert.match(recommendations(5.0).actions[0], /sweat/);
  });

  test("trend alerts detect a rapid alkaline rise", () => {
    const h = 3600e3;
    const alerts = trendAlerts([
      { ts: 0, ph: 6.0 },
      { ts: 6 * h, ph: 6.4 },
      { ts: 12 * h, ph: 6.9 },
    ]);
    assert.ok(alerts.some(a => /rose 0\.9/.test(a.text)));
    assert.ok(alerts.some(a => /last three scans/.test(a.text)));
    assert.deepEqual(trendAlerts([{ ts: 0, ph: 6 }]), []);
  });
});

describe("camera-to-data pipeline on simulated photos", () => {
  const phs = [5.2, 5.8, 6.3, 6.9, 7.3, 7.8, 8.6];
  for (const lighting of Object.keys(LIGHTING)) {
    test(`accurate under ${LIGHTING[lighting].label}`, () => {
      for (const [i, ph] of phs.entries()) {
        const img = renderBandage({
          ph,
          lighting,
          width: 480,
          height: 640,
          cx: 220 + i * 7,
          cy: 330 - i * 5,
          r: 120 + i * 4,
          seed: 11 + i,
        });
        const res = analyzeImage(img);
        assert.ok(res.ring.found, `ring found (pH ${ph})`);
        assert.ok(Math.abs(res.ph - ph) < 0.1, `${lighting}: expected ${ph}, got ${res.ph}`);
        assert.equal(res.risk.id, classifyRisk(ph).id);
        assert.equal(res.quality, "good");
      }
    });
  }

  test("lighting normalization is what makes it accurate", () => {
    // Warm light makes a yellow-zone wound look falsely "normal" without correction.
    const ph = 6.4;
    const res = analyzeImage(renderBandage({ ph, lighting: "warm", width: 480, height: 640 }));
    const [r, g] = res.center.raw;
    const naive = ratioToPh(r / g).ph;
    assert.notEqual(classifyRisk(naive).id, classifyRisk(ph).id);
    assert.ok(Math.abs(naive - ph) > 0.25, `uncorrected reading should be off (got ${naive})`);
    assert.ok(Math.abs(res.ph - ph) < 0.1);
    assert.equal(res.lighting.cast, "Warm");
  });

  test("detection locates the ring position and size", () => {
    const img = renderBandage({ ph: 6, width: 600, height: 800, cx: 250, cy: 430, r: 170 });
    const ring = detectRing(img);
    assert.ok(ring.found);
    assert.ok(Math.hypot(ring.cx - 250, ring.cy - 430) < 6, `centre ${ring.cx},${ring.cy}`);
    assert.ok(Math.abs(ring.r - 170) / 170 < 0.06, `radius ${ring.r}`);
  });

  test("a guide-circle hint constrains the search", () => {
    const img = renderBandage({ ph: 7, width: 400, height: 400, cx: 200, cy: 200, r: 110 });
    const ring = detectRing(img, { hint: { cx: 205, cy: 195, r: 120 } });
    assert.ok(ring.found);
    assert.ok(Math.hypot(ring.cx - 200, ring.cy - 200) < 5);
  });

  test("a photo without a ring is reported as poor quality", () => {
    const w = 320;
    const h = 320;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 180;
      data[i + 1] = 140;
      data[i + 2] = 120;
      data[i + 3] = 255;
    }
    const res = analyzeImage({ width: w, height: h, data });
    assert.equal(res.ring.found, false);
    assert.equal(res.quality, "poor");
  });

  test("a manual ring bypasses detection", () => {
    const img = renderBandage({ ph: 6.6, width: 400, height: 500, cx: 200, cy: 240, r: 120 });
    const res = analyzeImage(img, { ring: { cx: 200, cy: 240, r: 120 } });
    assert.equal(res.ring.manual, true);
    assert.ok(Math.abs(res.ph - 6.6) < 0.1);
  });

  test("custom calibration curves are honoured", () => {
    const curve = DEFAULT_CURVE.map(p => ({ ph: p.ph + 0.5, ratio: p.ratio }));
    const res = analyzeImage(renderBandage({ ph: 6.0, width: 400, height: 500 }), { curve });
    assert.ok(Math.abs(res.ph - 6.5) < 0.1);
  });
});
