/**
 * Renders a photo-realistic-enough CelluSense bandage at a chosen pH under a
 * chosen lighting condition. Used for the "Demo bandage" button (a reliable
 * live-pitch fallback) and by the automated tests.
 *
 * Returns an ImageData-like object { width, height, data } — no DOM needed.
 */
import { DEFAULT_REFERENCE, GEOMETRY, indicatorColor, linearToSrgb, srgbToLinear } from "./analysis.js";

/** Lighting presets: per-channel illuminant gain, exposure, shadow strength. */
export const LIGHTING = Object.freeze({
  daylight: { label: "Daylight", gain: [1, 1, 1], exposure: 1, shadow: 0.12 },
  warm: { label: "Warm indoor bulb", gain: [1, 0.8, 0.52], exposure: 0.9, shadow: 0.18 },
  fluorescent: { label: "Fluorescent (hospital)", gain: [0.85, 1, 0.93], exposure: 0.95, shadow: 0.15 },
  dim: { label: "Dim room + shadow", gain: [0.96, 0.9, 0.82], exposure: 0.4, shadow: 0.45 },
  led: { label: "Cool LED", gain: [0.9, 0.96, 1], exposure: 1.02, shadow: 0.1 },
});

/** Small deterministic PRNG so renders (and tests) are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (edge, d, soft) => Math.min(1, Math.max(0, (d - edge) / soft + 0.5));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function renderBandage({
  ph = 6.0,
  lighting = "daylight",
  width = 720,
  height = 960,
  cx = width / 2,
  cy = height * 0.48,
  r = Math.min(width, height) * 0.3,
  noise = 3,
  seed = 7,
  reference = DEFAULT_REFERENCE,
} = {}) {
  const light = typeof lighting === "string" ? LIGHTING[lighting] || LIGHTING.daylight : lighting;
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(width * height * 4);

  const pad = indicatorColor(ph);
  const separator = [206, 200, 188];
  const white = reference.white;
  const black = reference.black;
  const backing = [228, 216, 200];
  const skinA = [214, 170, 142];
  const skinB = [178, 128, 102];
  const half = r * 1.45; // square adhesive backing half-size
  const soft = 1.2;

  // Shadow: a diagonal gradient across the frame (simulates a hand/phone shadow).
  const angle = seed % 2 ? 0.6 : -0.9;
  const sx = Math.cos(angle);
  const sy = Math.sin(angle);
  const span = Math.hypot(width, height) / 2;

  const linLUT = new Float64Array(256);
  for (let i = 0; i < 256; i++) linLUT[i] = srgbToLinear(i);

  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const f = d / r;

      // Skin background with gentle variation
      let c = mix(skinA, skinB, Math.min(1, Math.max(0, (y / height) * 0.7 + (x / width) * 0.3)));

      // Adhesive backing (rounded square)
      const qx = Math.max(0, Math.abs(dx) - half + 24);
      const qy = Math.max(0, Math.abs(dy) - half + 24);
      const sq = Math.hypot(qx, qy) - 24;
      c = mix(c, backing, 1 - smooth(0, sq, soft));

      // Concentric printed rings and indicator pad (outer → inner)
      const px = soft / r;
      c = mix(c, black, 1 - smooth(GEOMETRY.blackOuter, f, px));
      c = mix(c, white, 1 - smooth(GEOMETRY.whiteOuter, f, px));
      c = mix(c, separator, 1 - smooth(GEOMETRY.whiteInner, f, px));
      if (f < GEOMETRY.pad + px) {
        // subtle hydrogel texture + slightly darker rim
        const tex = 1 + (rand() - 0.5) * 0.04 - 0.05 * (f / GEOMETRY.pad) ** 4;
        const padC = pad.map(v => v * tex);
        c = mix(c, padC, 1 - smooth(GEOMETRY.pad, f, px));
      }

      // Lighting in linear light: illuminant × exposure × shadow
      const along = (dx * sx + dy * sy) / span; // −1 … 1
      const shade = 1 - light.shadow * (0.5 + 0.5 * along);
      for (let k = 0; k < 3; k++) {
        const v = Math.round(Math.min(255, Math.max(0, c[k])));
        const l = linLUT[v] * light.gain[k] * light.exposure * shade;
        data[o + k] = Math.round(linearToSrgb(l) + (rand() - 0.5) * 2 * noise);
      }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { width, height, data };
}
