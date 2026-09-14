"use strict";

/**
 * End-to-end tests through a real browser.
 *
 * The server runs against the in-memory database stand-in (no mongod in this
 * environment), but everything above it is real: the Express app, the PWA, the
 * service worker registration, and the browser's own geolocation API — which
 * Playwright can position precisely, so the geofence is exercised for real
 * rather than mocked out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium, devices } = require("playwright");

const BROWSER_ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-that-is-long-enough-to-pass";
process.env.CRON_ENABLED = "false";

const db = require("../config/db");
const { MemoryDb } = require("./helpers/memory-mongo");
const { createApp } = require("../app");
const settingsService = require("../modules/settings/settings.service");
const employeesService = require("../modules/employees/employees.service");

const OFFICE = { lat: 9.005401, lng: 38.763611 };
const AWAY = { lat: 9.02, lng: 38.79 };
const TZ = "Africa/Addis_Ababa";

let server;
let browser;
let baseUrl;

test.before(async () => {
  const memory = new MemoryDb();
  db.__setDbForTests(memory);
  await db.ensureIndexes(memory);

  await settingsService.updateSettings({ companyName: "Browser Co", timeZone: TZ });
  await settingsService.createOffice({ name: "HQ", ...OFFICE, radiusMeters: 120, active: true });
  const shift = await settingsService.createShift({
    name: "Standard",
    startTime: "09:00",
    endTime: "17:00",
    workDays: [0, 1, 2, 3, 4, 5, 6], // every day, so the test passes whenever it runs
    graceMinutes: 10,
    breakMinutes: 60,
    isDefault: true,
  });

  await employeesService.create({
    name: "Ada Admin",
    email: "admin@browser.co",
    password: "password123",
    role: "admin",
    department: "Management",
    mustChangePassword: false,
  });
  // A second employee, so the geofence test starts from a clean day rather
  // than inheriting Sam's completed one.
  await employeesService.create({
    name: "Rita Remote",
    email: "rita@browser.co",
    password: "password123",
    department: "Sales",
    shiftId: String(shift._id),
    mustChangePassword: false,
  });
  await employeesService.create({
    name: "Sam Staff",
    email: "sam@browser.co",
    password: "password123",
    department: "Sales",
    shiftId: String(shift._id),
    mustChangePassword: false,
  });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The bundled browser lives under a versioned directory; find it rather than
  // hard-coding a build number, and fall back to whatever Playwright resolves.
  const bundled = fs
    .readdirSync(BROWSER_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => path.join(BROWSER_ROOT, entry.name, "chrome-linux", "chrome"))
    .find((candidate) => fs.existsSync(candidate));

  browser = await chromium.launch(bundled ? { executablePath: bundled } : {});
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

/** A phone-sized context standing at a given location. */
async function openPhone(coords) {
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    permissions: ["geolocation"],
    geolocation: { latitude: coords.lat, longitude: coords.lng, accuracy: 12 },
    locale: "en-GB",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { context, page, errors };
}

async function signIn(page, email, password = "password123") {
  await page.goto(baseUrl);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an employee signs in, sees the check-in screen, and checks in and out", async () => {
  const { context, page, errors } = await openPhone(OFFICE);
  try {
    await signIn(page, "sam@browser.co");

    await page.getByRole("button", { name: /Check in/ }).first().waitFor({ timeout: 15000 });
    // The ambient status line should place them at the office.
    await page.getByText(/At HQ/).waitFor({ timeout: 15000 });

    await page.locator(".punch").click();
    await page.locator(".toast.ok", { hasText: "Checked in at HQ" }).waitFor({ timeout: 25000 });

    // The button flips to check-out, and the day summary appears.
    await page.locator(".punch.out").waitFor({ timeout: 10000 });
    await page.getByText("Checked in at HQ.").waitFor({ timeout: 10000 });

    await page.locator(".punch").click();
    await page.locator(".toast.ok", { hasText: "Checked out from HQ" }).waitFor({ timeout: 25000 });
    await page.getByText("All done").waitFor({ timeout: 10000 });

    assert.deepEqual(errors, [], "the page must not log errors");
  } finally {
    await context.close();
  }
});

test("checking in from outside the geofence is refused with the distance", async () => {
  const { context, page } = await openPhone(AWAY);
  try {
    await signIn(page, "rita@browser.co");
    await page.locator(".punch:not([disabled])").waitFor({ timeout: 15000 });

    // The status line warns before the button is even pressed.
    await page.getByText(/m from HQ/).waitFor({ timeout: 15000 });

    await page.locator(".punch").click();
    const toast = page.locator(".toast.error");
    await toast.waitFor({ timeout: 20000 });
    const message = await toast.textContent();
    assert.match(message, /You're not at the office yet/);
    assert.match(message, /check-in is allowed within 120 m/);
  } finally {
    await context.close();
  }
});

test("an employee requests leave and sees it as pending", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await signIn(page, "sam@browser.co");
    await page.getByRole("button", { name: "Leave" }).click();
    await page.getByRole("button", { name: "New request" }).click();

    await page.getByLabel("Type").selectOption("annual");
    await page.getByLabel("Reason").fill("Family event out of town");
    await page.getByRole("button", { name: "Send request" }).click();

    await page.getByText("Request sent for approval").waitFor({ timeout: 10000 });
    await page.getByText("Annual leave").first().waitFor();
    await page.locator(".pill.pending").first().waitFor();
  } finally {
    await context.close();
  }
});

test("an admin sees the dashboard, approves the request, and exports a report", async () => {
  const { context, page, errors } = await openPhone(OFFICE);
  try {
    await signIn(page, "admin@browser.co");

    // Dashboard: the employee who checked in earlier is counted.
    await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 15000 });
    await page.getByText("On site now").first().waitFor();
    await page.locator(".chart").waitFor();

    // The pending request from the previous test is waiting here.
    await page.getByRole("button", { name: /Requests/ }).click();
    await page.getByText("Sam Staff").first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Approve" }).first().click();
    await page.getByText("Request approved").waitFor({ timeout: 10000 });

    // Reports: totals render, and the Excel export downloads.
    await page.getByRole("button", { name: "Reports" }).click();
    await page.getByRole("heading", { name: "By employee" }).waitFor({ timeout: 15000 });

    // The headline tiles must agree with the table under them; they read zero
    // for a while because the totals were summed after the rows were dropped.
    const presentTile = page.locator(".stat", { hasText: "Days present" }).locator(".value");
    assert.notEqual((await presentTile.textContent()).trim(), "0", "report totals should not be zero");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 25000 }),
      page.getByRole("button", { name: "Export Excel" }).click(),
    ]);
    assert.match(download.suggestedFilename(), /^attendance_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx$/);

    assert.deepEqual(errors, [], "the admin screens must not log errors");
  } finally {
    await context.close();
  }
});

test("an admin corrects a punch from the records screen", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await signIn(page, "admin@browser.co");
    await page.getByRole("button", { name: "Records" }).click();
    await page.getByRole("heading", { name: "Daily records" }).waitFor({ timeout: 15000 });

    const samRow = page.locator("tr", { hasText: "Sam Staff" }).first();
    await samRow.getByRole("button").click();

    await page.getByLabel("Check in").fill("09:00");
    await page.getByLabel("Check out").fill("17:00");
    await page.getByLabel("Note").fill("Corrected after a GPS failure");
    await page.getByRole("button", { name: "Save" }).click();

    await page.getByText("Record updated").waitFor({ timeout: 10000 });
    await page.locator("tr", { hasText: "Sam Staff" }).first().getByText("09:00").waitFor();
  } finally {
    await context.close();
  }
});

test("the PWA is installable: manifest, icons and service worker all serve", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await page.goto(baseUrl);

    const manifest = await page.evaluate(async () => {
      const response = await fetch("/manifest.webmanifest");
      return { status: response.status, body: await response.json() };
    });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.display, "standalone");
    assert.equal(manifest.body.icons.length, 3);

    for (const iconEntry of manifest.body.icons) {
      const status = await page.evaluate((src) => fetch(src).then((r) => r.status), iconEntry.src);
      assert.equal(status, 200, `${iconEntry.src} should be served`);
    }

    // The service worker must register, or the app will not install.
    const registered = await page.evaluate(() =>
      navigator.serviceWorker.ready.then(() => true).catch(() => false)
    );
    assert.equal(registered, true);
  } finally {
    await context.close();
  }
});

test("a wrong password is rejected without revealing whether the account exists", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await signIn(page, "sam@browser.co", "wrong-password");
    const toast = page.locator(".toast.error");
    await toast.waitFor({ timeout: 10000 });
    assert.match(await toast.textContent(), /Incorrect email or password/);

    await signIn(page, "nobody@browser.co", "wrong-password");
    await page.locator(".toast.error").last().waitFor({ timeout: 10000 });
    const messages = await page.locator(".toast.error").allTextContents();
    // Identical wording for a bad password and an unknown account.
    assert.ok(messages.every((m) => /Incorrect email or password/.test(m)));
  } finally {
    await context.close();
  }
});


test("a setup failure is shown on the sign-in screen, not left in the console", async () => {
  // A server whose API answers 503 the way a misconfigured deployment does.
  const http = require("http");
  const broken = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "database_unavailable",
            message: "The server is running but could not reach its database.",
            detail: "MongoServerSelectionError: connection timed out",
            hint: "On Atlas this is almost always Network Access: a serverless host has no fixed IP.",
          },
        })
      );
      return;
    }
    // Everything else comes from the real app, so the page under test is real.
    realApp(req, res);
  });
  const realApp = createApp();
  broken.listen(0);
  await new Promise((resolve) => broken.once("listening", resolve));
  const brokenUrl = `http://127.0.0.1:${broken.address().port}`;

  const { context, page } = await openPhone(OFFICE);
  try {
    await page.goto(brokenUrl);
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();

    const panel = page.locator(".setup-problem");
    await panel.waitFor({ timeout: 15000 });
    const text = await panel.textContent();

    assert.match(text, /not ready yet/);
    assert.match(text, /could not reach its database/);
    assert.match(text, /Network Access/, "the remedy must be on screen");
    assert.match(text, /MongoServerSelectionError/, "the underlying error should be visible");

    // It must still be there a few seconds later: this is not a toast.
    await page.waitForTimeout(6000);
    assert.equal(await panel.isVisible(), true, "a setup failure must not disappear on its own");
  } finally {
    await context.close();
    await new Promise((resolve) => broken.close(resolve));
  }
});


/** Widths that matter: a phone, a tablet in portrait, and a desktop. */
const VIEWPORTS = [
  ["phone", { width: 390, height: 844 }],
  ["tablet portrait", { width: 834, height: 1112 }],
  ["tablet landscape", { width: 1112, height: 834 }],
  ["desktop", { width: 1440, height: 900 }],
];

test("the app is branded weTech Attendance Management", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await page.goto(baseUrl);
    assert.equal(await page.title(), "weTech Attendance Management");

    const manifest = await page.evaluate(() => fetch("/manifest.webmanifest").then((r) => r.json()));
    assert.equal(manifest.name, "weTech Attendance Management");
    assert.equal(manifest.short_name, "weTech Attendance");

    // The sign-in card names the product, not a generic word.
    await page.getByRole("heading", { name: "weTech" }).waitFor({ timeout: 10000 });
    await page.getByText("Attendance Management").first().waitFor();
  } finally {
    await context.close();
  }
});

test("no screen scrolls sideways at any supported width", async () => {
  for (const [label, viewport] of VIEWPORTS) {
    const context = await browser.newContext({
      viewport,
      permissions: ["geolocation"],
      geolocation: { latitude: OFFICE.lat, longitude: OFFICE.lng, accuracy: 12 },
      locale: "en-GB",
    });
    const page = await context.newPage();
    try {
      await page.goto(baseUrl);
      await signIn(page, "admin@browser.co");
      await page.getByRole("heading", { name: "Today" }).waitFor({ timeout: 20000 });

      // Every admin screen, since the tables are the usual culprit.
      for (const tab of ["Dashboard", "Records", "People", "Reports", "Settings", "Check in"]) {
        await page.getByRole("button", { name: tab }).click();
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        assert.ok(
          overflow.scroll <= overflow.client + 1,
          `${label} / ${tab}: page scrolls sideways (${overflow.scroll} > ${overflow.client})`
        );
      }
    } finally {
      await context.close();
    }
  }
});

test("the navigation stays reachable and tappable on a phone", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await signIn(page, "sam@browser.co");
    await page.locator(".punch").waitFor({ timeout: 15000 });

    const bar = page.locator(".tabbar");
    const box = await bar.boundingBox();
    const viewport = page.viewportSize();

    // Pinned to the bottom of the screen, not scrolled off with the content.
    assert.ok(box.y + box.height <= viewport.height + 1, "the tab bar should sit within the viewport");

    // Touch targets large enough to hit: the usual guidance is 44px.
    const heights = await bar.locator("button").evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height)
    );
    for (const height of heights) {
      assert.ok(height >= 44, `a tab is only ${Math.round(height)}px tall`);
    }
  } finally {
    await context.close();
  }
});

test("the 3D backdrop is decorative: inert, hidden from assistive tech, and dropped for reduced motion", async () => {
  const { context, page } = await openPhone(OFFICE);
  try {
    await page.goto(baseUrl);
    const scene = page.locator(".auth .scene");
    await scene.waitFor({ timeout: 10000 });

    assert.equal(await scene.getAttribute("aria-hidden"), "true");
    assert.equal(
      await scene.evaluate((node) => getComputedStyle(node).pointerEvents),
      "none",
      "the backdrop must never intercept a tap meant for the form"
    );
    assert.ok((await scene.locator(".shape").count()) > 0);
  } finally {
    await context.close();
  }

  // Someone who asked for less motion gets no floating shapes at all.
  const reduced = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    locale: "en-GB",
  });
  const reducedPage = await reduced.newPage();
  try {
    await reducedPage.goto(baseUrl);
    await reducedPage.locator(".auth .card").waitFor({ timeout: 10000 });
    assert.equal(await reducedPage.locator(".shape").count(), 0, "no shapes should be built at all");
  } finally {
    await reduced.close();
  }
});
