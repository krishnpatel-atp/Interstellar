/**
 * CelluSense image analysis engine.
 *
 * Pipeline:  locate calibration ring → measure white + black references →
 *            correct lighting (per-channel, in linear light) → sample the
 *            indicator pad → R/G index → pH → risk zone.
 *
 * Pure functions only (no DOM), so the same code runs in the browser and in
 * Node tests. Images are ImageData-like: { width, height, data: RGBA bytes }.
 */

/* ------------------------------------------------------------------------ *
 * Bandage geometry, as fractions of the outer radius R of the black ring.
 *
 *        ┌──────── adhesive backing ────────┐
 *        │   ●●● black ring   0.90 – 1.00   │
 *        │   ○○○ white ring   0.62 – 0.90   │  ← printed reference colours
 *        │   ─── separator    0.56 – 0.62   │
 *        │   ███ indicator    0.00 – 0.56   │  ← CMC hydrogel pad
 *        └──────────────────────────────────┘
 * ------------------------------------------------------------------------ */
export const GEOMETRY = Object.freeze({
  pad: 0.56,
  whiteInner: 0.62,
  whiteOuter: 0.9,
  blackInner: 0.9,
  blackOuter: 1.0,
  // Sampling bands keep clear of edges so small detection errors don't matter.
  sampleWhite: [0.67, 0.76, 0.85],
  sampleBlack: [0.93, 0.97],
  samplePad: 0.38,
});

/** Printed reference colours as captured under neutral (D65) light. */
export const DEFAULT_REFERENCE = Object.freeze({
  white: [240, 240, 240],
  black: [30, 30, 30],
});

/**
 * Colour of the anthocyanin/curcumin indicator (under reference light) vs pH.
 * Rosy-purple when acidic, shifting to blue/indigo and green when alkaline.
 */
export const INDICATOR_COLORS = Object.freeze([
  [5.0, [200, 72, 140]],
  [5.5, [186, 74, 150]],
  [6.0, [166, 77, 160]],
  [6.5, [142, 80, 166]],
  [7.0, [117, 86, 170]],
  [7.5, [92, 96, 170]],
  [8.0, [72, 110, 160]],
  [8.5, [58, 124, 142]],
  [9.0, [52, 134, 118]],
]);

/** Default calibration curve: pH ↔ R/G index derived from the colours above. */
export const DEFAULT_CURVE = Object.freeze(
  INDICATOR_COLORS.map(([ph, [r, g]]) => Object.freeze({ ph, ratio: round(r / g, 3) })),
);

export const PH_MIN = 4.0;
export const PH_MAX = 10.0;

/* ------------------------------------------------------------------------ *
 * Colour helpers
 * ------------------------------------------------------------------------ */
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function srgbToLinear(v) {
  if (Number.isInteger(v) && v >= 0 && v <= 255) return LIN[v];
  const c = clamp(v, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(l) {
  const x = clamp(l, 0, 1);
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  return c * 255;
}

export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function round(v, digits = 0) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function median(values) {
  if (!values.length) return Number.NaN;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function trimmedMean(values, trim = 0.15) {
  if (!values.length) return Number.NaN;
  const s = Float64Array.from(values).sort();
  const k = Math.floor(s.length * trim);
  let sum = 0;
  for (let i = k; i < s.length - k; i++) sum += s[i];
  return sum / (s.length - 2 * k);
}

/** Indicator colour at a given pH (linear interpolation of the table). */
export function indicatorColor(ph) {
  const t = INDICATOR_COLORS;
  if (ph <= t[0][0]) return [...t[0][1]];
  if (ph >= t[t.length - 1][0]) return [...t[t.length - 1][1]];
  for (let i = 0; i < t.length - 1; i++) {
    const [p0, c0] = t[i];
    const [p1, c1] = t[i + 1];
    if (ph <= p1) {
      const f = (ph - p0) / (p1 - p0);
      return c0.map((c, k) => c + (c1[k] - c) * f);
    }
  }
  return [...t[t.length - 1][1]];
}

/* ------------------------------------------------------------------------ *
 * Calibration curve: R/G index → pH
 * ------------------------------------------------------------------------ */

/** Validates a curve: ≥2 points, finite numbers, ratio strictly falling as pH rises. */
export function validateCurve(curve) {
  if (!Array.isArray(curve) || curve.length < 2) {
    return "The calibration curve needs at least two points.";
  }
  for (const p of curve) {
    if (!Number.isFinite(p?.ph) || !Number.isFinite(p?.ratio) || p.ratio <= 0) {
      return "Every calibration point needs a valid pH and a positive R/G index.";
    }
  }
  const sorted = [...curve].sort((a, b) => a.ph - b.ph);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ph === sorted[i - 1].ph) return `pH ${sorted[i].ph} appears twice.`;
    if (!(sorted[i].ratio < sorted[i - 1].ratio)) {
      return "R/G index must decrease as pH increases (the pad turns bluer/greener).";
    }
  }
  return null;
}

export function ratioToPh(ratio, curve = DEFAULT_CURVE) {
  if (!Number.isFinite(ratio)) return { ph: Number.NaN, inRange: false };
  const pts = [...curve].sort((a, b) => a.ph - b.ph);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const lerp = (a, b) => a.ph + ((ratio - a.ratio) * (b.ph - a.ph)) / (b.ratio - a.ratio);

  if (ratio >= first.ratio) {
    return { ph: clamp(lerp(pts[0], pts[1]), PH_MIN, first.ph), inRange: ratio === first.ratio };
  }
  if (ratio <= last.ratio) {
    return {
      ph: clamp(lerp(pts[pts.length - 2], last), last.ph, PH_MAX),
      inRange: ratio === last.ratio,
    };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (ratio <= pts[i].ratio && ratio >= pts[i + 1].ratio) {
      return { ph: lerp(pts[i], pts[i + 1]), inRange: true };
    }
  }
  return { ph: Number.NaN, inRange: false };
}

/* ------------------------------------------------------------------------ *
 * Clinical risk scoring
 * ------------------------------------------------------------------------ */
export const ZONES = Object.freeze({
  low: {
    id: "low",
    label: "Low",
    zone: "Green Zone",
    title: "Normal Healing Process",
    range: "pH 5.5 – 6.2",
  },
  observation: {
    id: "observation",
    label: "Observation",
    zone: "Yellow Zone",
    title: "Elevated Alkaline Shift — Flag for Observation",
    range: "pH 6.3 – 7.2",
  },
  high: {
    id: "high",
    label: "High",
    zone: "Red Zone",
    title: "High Risk of Surgical Site Infection",
    range: "pH ≥ 7.3",
  },
});

/** Zone thresholds apply to the displayed (1-decimal) value so UI and logic agree. */
export function classifyRisk(ph) {
  const p = round(ph, 1);
  if (p >= 7.3) return ZONES.high;
  if (p >= 6.3) return ZONES.observation;
  return ZONES.low;
}

export function recommendations(ph) {
  const zone = classifyRisk(ph).id;
  const p = round(ph, 1);
  if (zone === "high") {
    return {
      headline: "Alert care team",
      actions: [
        "Notify the care team / surgeon now",
        "Clean the wound site and inspect for redness, warmth, swelling or discharge",
        "Check temperature and document findings",
        "Rescan after the dressing change",
      ],
    };
  }
  if (zone === "observation") {
    return {
      headline: "Clean wound site & monitor closely",
      actions: [
        "Clean the wound site and replace the dressing",
        "Increase scans to every 4–6 hours",
        "Watch for redness, warmth, odour or increasing pain",
        "Escalate to the care team if pH reaches 7.3 or keeps rising",
      ],
    };
  }
  return {
    headline: "Continue routine care",
    actions: [
      p < 5.5
        ? "Acidic reading — consistent with healthy skin or sweat (pH 4.5–5.5)"
        : "Wound environment is in the normal healing range",
      "Keep the dressing clean and dry",
      "Rescan in 12–24 hours or at the next dressing change",
    ],
  };
}

/**
 * Looks at recent history (oldest → newest) for patterns worth flagging.
 * @param {{ts:number, ph:number}[]} history
 */
export function trendAlerts(history) {
  const alerts = [];
  if (history.length < 2) return alerts;
  const latest = history[history.length - 1];
  const dayAgo = latest.ts - 24 * 3600 * 1000;
  const window = history.filter(h => h.ts >= dayAgo);
  const minRecent = Math.min(...window.map(h => h.ph));
  if (latest.ph - minRecent >= 0.5) {
    alerts.push({
      level: "warn",
      text: `pH rose ${round(latest.ph - minRecent, 1).toFixed(1)} units in the last 24 h — a rapid alkaline shift.`,
    });
  }
  const last3 = history.slice(-3);
  if (last3.length === 3 && last3[1].ph - last3[0].ph >= 0.1 && last3[2].ph - last3[1].ph >= 0.1) {
    alerts.push({ level: "info", text: "pH has risen on each of the last three scans." });
  }
  return alerts;
}

/* ------------------------------------------------------------------------ *
 * Ring detection
 * ------------------------------------------------------------------------ */

/** Down-sampled luma + chroma maps used for the circle search. */
function buildMaps(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const L = new Float32Array(w * h);
  const C = new Float32Array(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // average a 2×2 grid of source pixels inside this cell
      let l = 0;
      let c = 0;
      for (let j = 0; j < 2; j++) {
        const yy = Math.min(img.height - 1, Math.floor((y + 0.25 + j * 0.5) * sy));
        for (let i = 0; i < 2; i++) {
          const xx = Math.min(img.width - 1, Math.floor((x + 0.25 + i * 0.5) * sx));
          const o = (yy * img.width + xx) * 4;
          const r = d[o];
          const g = d[o + 1];
          const b = d[o + 2];
          l += luma(r, g, b);
          c += Math.max(r, g, b) - Math.min(r, g, b);
        }
      }
      L[y * w + x] = l / 4;
      C[y * w + x] = c / 4;
    }
  }
  return { w, h, L, C, scale: w / img.width };
}

function makeAngles(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.1;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}
const ANGLES_COARSE = makeAngles(24);
const ANGLES_FINE = makeAngles(48);

function sampleMap(arr, m, x, y) {
  const xi = x < 0 ? 0 : x >= m.w ? m.w - 1 : x | 0;
  const yi = y < 0 ? 0 : y >= m.h ? m.h - 1 : y | 0;
  return arr[yi * m.w + xi];
}

/** How much the circle (cx, cy, r) looks like a white ring inside a black ring. */
function ringScore(m, cx, cy, r, angles) {
  if (cx - r < -0.5 || cy - r < -0.5 || cx + r > m.w + 0.5 || cy + r > m.h + 0.5) {
    return { score: Number.NEGATIVE_INFINITY };
  }
  let wSum = 0;
  let wSq = 0;
  let wC = 0;
  let nW = 0;
  let bSum = 0;
  let nB = 0;
  let pSum = 0;
  let nP = 0;
  let oSum = 0;
  for (const [cos, sin] of angles) {
    for (const f of GEOMETRY.sampleWhite) {
      const x = cx + cos * r * f;
      const y = cy + sin * r * f;
      const v = sampleMap(m.L, m, x, y);
      wSum += v;
      wSq += v * v;
      wC += sampleMap(m.C, m, x, y);
      nW++;
    }
    for (const f of GEOMETRY.sampleBlack) {
      bSum += sampleMap(m.L, m, cx + cos * r * f, cy + sin * r * f);
      nB++;
    }
    pSum += sampleMap(m.L, m, cx + cos * r * 0.3, cy + sin * r * 0.3);
    nP++;
    oSum += sampleMap(m.L, m, cx + cos * r * 1.08, cy + sin * r * 1.08);
  }
  const white = wSum / nW;
  const whiteStd = Math.sqrt(Math.max(0, wSq / nW - white * white));
  const black = bSum / nB;
  const pad = pSum / nP;
  const outside = oSum / angles.length;
  const score =
    white -
    black +
    0.35 * Math.min(white - pad, 80) +
    0.3 * Math.min(outside - black, 60) -
    0.9 * whiteStd -
    0.4 * (wC / nW);
  return { score, white, black, pad, whiteStd };
}

/**
 * Finds the calibration ring.
 * @param img ImageData-like
 * @param opts.hint optional { cx, cy, r } in image pixels (e.g. the on-screen
 *        guide circle) — the search is then constrained around it.
 * @returns {{found:boolean, cx:number, cy:number, r:number, confidence:number}}
 */
export function detectRing(img, { hint = null } = {}) {
  const coarse = buildMaps(img, 160);
  const minDim = Math.min(coarse.w, coarse.h);
  let rMin = minDim * 0.1;
  let rMax = minDim * 0.5;
  let cxRange = [0, coarse.w];
  let cyRange = [0, coarse.h];
  if (hint) {
    const hr = hint.r * coarse.scale;
    rMin = Math.max(rMin, hr * 0.6);
    rMax = Math.min(rMax, hr * 1.4);
    const slack = hr * 0.45;
    cxRange = [hint.cx * coarse.scale - slack, hint.cx * coarse.scale + slack];
    cyRange = [hint.cy * coarse.scale - slack, hint.cy * coarse.scale + slack];
  }

  const top = [];
  for (let r = rMin; r <= rMax; r *= 1.06) {
    const step = Math.max(1.5, r * 0.14);
    const x0 = Math.max(r, cxRange[0]);
    const x1 = Math.min(coarse.w - r, cxRange[1]);
    const y0 = Math.max(r, cyRange[0]);
    const y1 = Math.min(coarse.h - r, cyRange[1]);
    for (let cy = y0; cy <= y1; cy += step) {
      for (let cx = x0; cx <= x1; cx += step) {
        const { score } = ringScore(coarse, cx, cy, r, ANGLES_COARSE);
        if (score > (top.length < 6 ? Number.NEGATIVE_INFINITY : top[top.length - 1].score)) {
          top.push({ score, cx, cy, r, step });
          top.sort((a, b) => b.score - a.score);
          if (top.length > 6) top.pop();
        }
      }
    }
  }

  const fine = buildMaps(img, 480);
  const k = fine.scale / coarse.scale;
  let best = null;
  for (const cand of top) {
    const cx0 = cand.cx * k;
    const cy0 = cand.cy * k;
    const r0 = cand.r * k;
    const span = cand.step * k;
    const st = Math.max(1, span / 4);
    for (let r = r0 * 0.9; r <= r0 * 1.1; r += r0 * 0.015) {
      for (let cy = cy0 - span; cy <= cy0 + span; cy += st) {
        for (let cx = cx0 - span; cx <= cx0 + span; cx += st) {
          const s = ringScore(fine, cx, cy, r, ANGLES_FINE);
          if (!best || s.score > best.score) best = { ...s, cx, cy, r };
        }
      }
    }
  }

  if (!best || !Number.isFinite(best.score)) {
    return hint
      ? { found: false, ...hint, confidence: 0 }
      : {
          found: false,
          cx: img.width / 2,
          cy: img.height / 2,
          r: Math.min(img.width, img.height) * 0.3,
          confidence: 0,
        };
  }

  const contrast = best.white - best.black;
  const confidence = clamp(((contrast - 35) / 110) * (1 - clamp(best.whiteStd / 45, 0, 0.8)), 0, 1);
  const found = contrast > 45 && best.white - best.pad > 8 && confidence > 0.15;
  const inv = 1 / fine.scale;
  const detected = { cx: best.cx * inv, cy: best.cy * inv, r: best.r * inv };
  if (!found && hint) return { found: false, ...hint, confidence };
  return { found, ...detected, confidence: round(confidence, 2) };
}

/* ------------------------------------------------------------------------ *
 * Measurement + lighting normalisation
 * ------------------------------------------------------------------------ */
function pixel(img, x, y) {
  const xi = clamp(Math.round(x), 0, img.width - 1);
  const yi = clamp(Math.round(y), 0, img.height - 1);
  const o = (yi * img.width + xi) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

function annulusMedian(img, ring, radii) {
  const n = Math.max(90, Math.min(360, Math.round(ring.r * 1.5)));
  const ch = [[], [], []];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (const f of radii) {
      const p = pixel(img, ring.cx + cos * ring.r * f, ring.cy + sin * ring.r * f);
      ch[0].push(p[0]);
      ch[1].push(p[1]);
      ch[2].push(p[2]);
    }
  }
  return ch.map(median);
}

/**
 * Full analysis of a photo.
 * @param img ImageData-like
 * @param opts.ring   use this ring instead of detecting ({cx, cy, r})
 * @param opts.hint   guide circle to constrain detection
 * @param opts.curve  calibration curve
 * @param opts.reference printed reference colours
 */
export function analyzeImage(
  img,
  { ring = null, hint = null, curve = DEFAULT_CURVE, reference = DEFAULT_REFERENCE } = {},
) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const detection = ring ? { found: true, manual: true, confidence: 1, ...ring } : detectRing(img, { hint });
  const R = { cx: detection.cx, cy: detection.cy, r: detection.r };

  // 1. Reference ring measurements (median = robust to specks and glare).
  const whiteRaw = annulusMedian(img, R, GEOMETRY.sampleWhite);
  const blackRaw = annulusMedian(img, R, GEOMETRY.sampleBlack);

  // 2. Per-channel lighting correction in linear light:
  //    corrected = refBlack + (c − measuredBlack) · (refWhite − refBlack)/(measuredWhite − measuredBlack)
  const refW = reference.white.map(srgbToLinear);
  const refK = reference.black.map(srgbToLinear);
  const W = whiteRaw.map(srgbToLinear);
  const K = blackRaw.map(srgbToLinear);
  let mode = "two-point";
  let gain = W.map((w, i) => (refW[i] - refK[i]) / (w - K[i]));
  let offset = K.map((k, i) => refK[i] - k * gain[i]);
  if (W.some((w, i) => w - K[i] < 0.03) || gain.some(g => !Number.isFinite(g) || g <= 0)) {
    mode = "white-only";
    gain = W.map((w, i) => refW[i] / Math.max(w, 1e-4));
    offset = [0, 0, 0];
  }
  const correct = (lin, i) => lin * gain[i] + offset[i];

  // 3. Indicator pad: trimmed mean of the central disc, skipping glare.
  const padR = R.r * GEOMETRY.samplePad;
  const step = Math.max(1, Math.floor(padR / 45));
  const lin = [[], [], []];
  const gVals = [];
  let glare = 0;
  let total = 0;
  const glareLimit = whiteRaw.map(v => Math.min(252, v * 0.97));
  for (let y = -padR; y <= padR; y += step) {
    for (let x = -padR; x <= padR; x += step) {
      if (x * x + y * y > padR * padR) continue;
      const p = pixel(img, R.cx + x, R.cy + y);
      total++;
      if (p[0] >= glareLimit[0] && p[1] >= glareLimit[1] && p[2] >= glareLimit[2]) {
        glare++;
        continue;
      }
      lin[0].push(LIN[p[0]]);
      lin[1].push(LIN[p[1]]);
      lin[2].push(LIN[p[2]]);
      gVals.push(p[1]);
    }
  }
  const rawLin = lin.map(c => trimmedMean(c));
  const rawRgb = rawLin.map(linearToSrgb);
  const correctedRgb = rawLin.map((l, i) => linearToSrgb(correct(l, i)));

  // 4. R/G index → pH → risk
  const ratio = correctedRgb[0] / Math.max(correctedRgb[1], 1);
  const { ph, inRange } = ratioToPh(ratio, curve);
  const risk = classifyRisk(ph);

  // 5. Quality checks
  const issues = [];
  if (!detection.found) {
    issues.push({
      level: "error",
      text: "Calibration ring not detected — result uses the guide circle and may be inaccurate.",
    });
  } else if (detection.confidence < 0.4) {
    issues.push({ level: "warn", text: "Calibration ring is faint or partly obscured." });
  }
  if (Math.max(...whiteRaw) >= 250) {
    issues.push({
      level: "warn",
      text: "Reference ring is overexposed — avoid direct light or flash glare.",
    });
  }
  const whiteLuma = luma(...whiteRaw);
  if (whiteLuma < 45) {
    issues.push({ level: "warn", text: "Scene is very dark — move to better light for a reliable reading." });
  }
  const glareFrac = total ? glare / total : 1;
  if (glareFrac > 0.2) {
    issues.push({
      level: "warn",
      text: `Glare covers ${Math.round(glareFrac * 100)}% of the indicator pad.`,
    });
  }
  if (gVals.length < 20) {
    issues.push({ level: "error", text: "Not enough of the indicator pad is visible." });
  } else {
    const gm = gVals.reduce((a, b) => a + b, 0) / gVals.length;
    const gs = Math.sqrt(gVals.reduce((a, b) => a + (b - gm) ** 2, 0) / gVals.length);
    if (gm > 0 && gs / gm > 0.3) {
      issues.push({
        level: "warn",
        text: "Indicator pad colour is uneven — check the bandage is flat and in focus.",
      });
    }
  }
  if (!inRange) {
    issues.push({
      level: "info",
      text: "Reading is outside the calibrated pH range; value is extrapolated.",
    });
  }
  const quality = issues.some(i => i.level === "error")
    ? "poor"
    : issues.some(i => i.level === "warn")
      ? "fair"
      : "good";

  // Human-readable lighting description
  const brightness = whiteLuma / luma(...reference.white);
  const warmth = whiteRaw[2] / Math.max(whiteRaw[0], 1);
  const cast = warmth < 0.8 ? "Warm" : warmth > 1.12 ? "Cool" : "Neutral";
  const level = brightness < 0.55 ? "dim" : brightness > 1.02 ? "bright" : "normal";

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    ring: { ...R, found: detection.found, manual: !!detection.manual, confidence: detection.confidence },
    reference: { whiteRaw, blackRaw, mode, gains: gain.map(g => round(g / gain[1], 3)) },
    lighting: { brightness: round(brightness, 2), cast, level },
    center: {
      raw: rawRgb.map(v => round(v)),
      corrected: correctedRgb.map(v => round(v)),
      glare: round(glareFrac, 3),
    },
    ratio: round(ratio, 3),
    ph: round(ph, 2),
    phDisplay: round(ph, 1).toFixed(1),
    inRange,
    risk,
    recommendation: recommendations(ph),
    quality,
    issues,
    ms: Math.round(t1 - t0),
  };
}
