"use strict";

/**
 * Render the PWA icons from the weTech mark.
 *
 * iOS will not use an SVG for a home-screen icon, so these have to be raster.
 * Rather than keeping opaque PNGs in the repository that nobody can
 * regenerate, they are rendered from icons/wetech-mark.svg by the browser
 * that is already here for the tests — so changing the mark means changing one
 * SVG and re-running this.
 *
 *   npm run icons
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ICONS = path.join(ROOT, "public", "icons");
const MARK = path.join(ICONS, "wetech-mark.svg");

const BRAND = "#1f4ed8";

const TARGETS = [
  // Transparent, for contexts that supply their own background.
  { file: "icon-192.png", size: 192, background: null, pad: 0.06 },
  { file: "icon-512.png", size: 512, background: null, pad: 0.06 },
  // Maskable icons are cropped to a circle by some launchers, so the artwork
  // sits well inside a filled square.
  { file: "icon-maskable-512.png", size: 512, background: "#ffffff", pad: 0.22 },
  { file: "favicon-48.png", size: 48, background: null, pad: 0.04 },
];

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!fs.existsSync(root)) return null;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => path.join(root, entry.name, "chrome-linux", "chrome"))
    .find((candidate) => fs.existsSync(candidate));
}

const page = (svg, size, background, pad) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  body { width: ${size}px; height: ${size}px; background: ${background || "transparent"};
         display: grid; place-items: center; }
  .mark { width: ${Math.round(size * (1 - pad * 2))}px; height: ${Math.round(size * (1 - pad * 2))}px; }
  svg { width: 100%; height: 100%; display: block; }
</style></head><body><div class="mark">${svg}</div></body></html>`;

async function main() {
  const svg = fs.readFileSync(MARK, "utf8");
  const executablePath = findChromium();

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error(
      "Playwright is needed to render the icons. Run `npm install` first, or edit\n" +
        "public/icons/wetech-mark.svg and render the PNGs with any tool you prefer."
    );
    process.exit(1);
  }

  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    for (const target of TARGETS) {
      const context = await browser.newContext({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1,
      });
      const tab = await context.newPage();
      await tab.setContent(page(svg, target.size, target.background, target.pad));
      await tab.waitForTimeout(80); // let the gradients paint
      const file = path.join(ICONS, target.file);
      await tab.screenshot({ path: file, omitBackground: !target.background });
      await context.close();
      console.log(`wrote ${path.relative(ROOT, file)} (${fs.statSync(file).size} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
