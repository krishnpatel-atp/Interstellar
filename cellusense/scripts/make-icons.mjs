// Renders the PNG app icons (no dependencies): node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(size, { maskable = false } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  const a = [0x2d, 0xd4, 0xbf];
  const b = [0x02, 0x84, 0xc7];
  const radius = maskable ? 0 : 0.22; // corner radius (fraction)
  const scale = maskable ? 0.8 : 1; // keep artwork inside the maskable safe zone
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          // rounded-square background
          const qx = Math.max(0, Math.abs(u - 0.5) - (0.5 - radius));
          const qy = Math.max(0, Math.abs(v - 0.5) - (0.5 - radius));
          if (Math.hypot(qx, qy) > radius) continue;
          const t = (u + v) / 2;
          let c = a.map((ch, i) => ch + (b[i] - ch) * t);
          const d = Math.hypot(u - 0.5, v - 0.5) / scale;
          if ((d > 0.258 && d < 0.328) || d < 0.145) c = c.map(ch => ch + (255 - ch) * 0.93);
          r += c[0];
          g += c[1];
          bl += c[2];
          al += 255;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const cov = al / 255;
      out[o] = cov ? r / cov : 0;
      out[o + 1] = cov ? g / cov : 0;
      out[o + 2] = cov ? bl / cov : 0;
      out[o + 3] = al / n;
    }
  }
  return png(size, out);
}

const dir = new URL("../icons/", import.meta.url);
writeFileSync(new URL("icon-192.png", dir), render(192));
writeFileSync(new URL("icon-512.png", dir), render(512));
writeFileSync(new URL("maskable-512.png", dir), render(512, { maskable: true }));
console.log("Icons written to icons/");
