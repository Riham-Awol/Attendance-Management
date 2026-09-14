"use strict";

/**
 * Generate the PWA icons as real PNGs, with no image library and no network.
 *
 * iOS will not use an SVG for a home-screen icon, so these have to be raster.
 * Everything is drawn by distance functions and encoded with Node's own zlib,
 * which keeps the repo free of binary assets nobody can regenerate.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BLUE = [31, 78, 216];
const WHITE = [255, 255, 255];

const clamp01 = (n) => Math.min(1, Math.max(0, n));
/** 1 inside the shape, 0 outside, with one pixel of blend in between. */
const coverage = (distance) => clamp01(0.5 - distance);

/** Signed distance from a point to a rounded rectangle. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance from a point to a thick line segment (a capsule). */
function segmentDistance(x, y, x1, y1, x2, y2, halfWidth) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : clamp01(((x - x1) * vx + (y - y1) * vy) / lengthSq);
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) - halfWidth;
}

function blend(target, offset, color, alpha) {
  if (alpha <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    target[offset + c] = Math.round(target[offset + c] * (1 - alpha) + color[c] * alpha);
  }
  target[offset + 3] = Math.round(target[offset + 3] * (1 - alpha) + 255 * alpha);
}

/**
 * A clock face with a tick inside it: the two ideas the app is about, legible
 * down to 48 px.
 */
function drawIcon(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const c = size / 2;
  // A maskable icon can be cropped to a circle by the launcher, so the artwork
  // stays inside the safe zone and the background covers the whole square.
  const plateHalf = maskable ? size / 2 : size * 0.46;
  const plateRadius = maskable ? 0 : size * 0.22;
  const faceRadius = size * (maskable ? 0.3 : 0.33);
  const ringWidth = size * 0.055;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const offset = (y * size + x) * 4;

      blend(pixels, offset, BLUE, coverage(roundedRectDistance(px, py, c, c, plateHalf, plateHalf, plateRadius)));

      // Clock ring.
      const fromCentre = Math.hypot(px - c, py - c);
      blend(pixels, offset, WHITE, coverage(Math.abs(fromCentre - faceRadius) - ringWidth / 2));

      // Tick mark inside the face.
      const shortArm = segmentDistance(px, py, c - faceRadius * 0.42, c + faceRadius * 0.02, c - faceRadius * 0.1, c + faceRadius * 0.34, ringWidth * 0.55);
      const longArm = segmentDistance(px, py, c - faceRadius * 0.1, c + faceRadius * 0.34, c + faceRadius * 0.45, c - faceRadius * 0.34, ringWidth * 0.55);
      blend(pixels, offset, WHITE, coverage(Math.min(shortArm, longArm)));
    }
  }
  return pixels;
}

/** Minimal PNG encoder: 8-bit RGBA, one IDAT, filter type 0. */
function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

const outDir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["favicon-48.png", 48, {}],
];

for (const [name, size, options] of targets) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodePng(drawIcon(size, options), size));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
