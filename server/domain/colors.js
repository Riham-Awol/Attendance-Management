"use strict";

/**
 * A stable colour per employee.
 *
 * Derived from the employee's id rather than stored, so a colour never has to
 * be assigned, migrated or kept unique by hand, and the same person is the
 * same colour on every device and in every export.
 *
 * The hues are a curated list rather than `hash % 360`: evenly spaced hues
 * include several that are muddy or nearly invisible on one of the two themes,
 * and putting red and green next to each other in an attendance tool invites
 * exactly the wrong reading.
 */

const PALETTE = [
  { name: "indigo", hex: "#4f46e5" },
  { name: "teal", hex: "#0d9488" },
  { name: "amber", hex: "#b45309" },
  { name: "violet", hex: "#7c3aed" },
  { name: "sky", hex: "#0284c7" },
  { name: "rose", hex: "#be123c" },
  { name: "emerald", hex: "#047857" },
  { name: "orange", hex: "#c2410c" },
  { name: "cyan", hex: "#0e7490" },
  { name: "fuchsia", hex: "#a21caf" },
  { name: "lime", hex: "#4d7c0f" },
  { name: "blue", hex: "#1d4ed8" },
  { name: "pink", hex: "#9d174d" },
  { name: "slate", hex: "#475569" },
  { name: "purple", hex: "#6b21a8" },
  { name: "green", hex: "#15803d" },
];

/** FNV-1a: small, fast, and spreads similar ids (…a1, …a2) far apart. */
function hash(value) {
  let h = 0x811c9dc5;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function colorFor(id) {
  return PALETTE[hash(id) % PALETTE.length];
}

/**
 * Colours for a group, nudged so that neighbours in the list differ.
 *
 * Two people on the same screen landing on the same colour is the one failure
 * that matters here, and with sixteen colours the birthday problem makes it
 * likely well before sixteen employees. Collisions are resolved by walking to
 * the next free colour, which keeps every assignment stable for a given list.
 */
function assignColors(ids) {
  const taken = new Set();
  const result = new Map();

  for (const id of ids) {
    const preferred = hash(id) % PALETTE.length;
    let index = preferred;
    for (let step = 0; step < PALETTE.length; step += 1) {
      const candidate = (preferred + step) % PALETTE.length;
      if (!taken.has(candidate)) {
        index = candidate;
        break;
      }
    }
    // More people than colours: the palette repeats rather than running out.
    taken.add(index);
    if (taken.size === PALETTE.length) taken.clear();
    result.set(String(id), PALETTE[index]);
  }
  return result;
}

module.exports = { PALETTE, colorFor, assignColors, hash };
