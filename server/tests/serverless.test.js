"use strict";

/**
 * The serverless deployment path: only /api/* reaches the function, the
 * scheduled jobs arrive as HTTP requests, and those must not be triggerable by
 * anyone who knows the URL.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.VERCEL = "1"; // must be set before config/env is first required
process.env.JWT_SECRET = "test-secret-that-is-long-enough-to-pass";
process.env.CRON_SECRET = "super-secret-cron-token";
// A hosted deployment must declare its database; the in-memory stand-in below
// means nothing actually dials this.
process.env.MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/test";

const env = require("../config/env");
const db = require("../config/db");
const { MemoryDb } = require("./helpers/memory-mongo");
const { createApp } = require("../app");
const settingsService = require("../modules/settings/settings.service");
const employeesService = require("../modules/employees/employees.service");

let server;
let baseUrl;

test.before(async () => {
  const memory = new MemoryDb();
  db.__setDbForTests(memory);
  await db.ensureIndexes(memory);

  await settingsService.updateSettings({ companyName: "Serverless Co", timeZone: "Africa/Addis_Ababa" });
  await settingsService.createShift({
    name: "Standard",
    startTime: "09:00",
    endTime: "17:00",
    workDays: [0, 1, 2, 3, 4, 5, 6],
    isDefault: true,
  });
  await employeesService.create({
    name: "Ada Admin",
    email: "admin@serverless.co",
    password: "password123",
    role: "admin",
  });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const get = (path, headers = {}) => fetch(`${baseUrl}${path}`, { headers });

test("the environment reports itself as serverless and disables in-process cron", () => {
  assert.equal(env.isServerless, true);
  assert.equal(env.cron.enabled, false, "node-cron must not run where there is no long-lived process");
});

test("the API still answers on the serverless path", async () => {
  const response = await get("/api/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.serverless, true);
  // The echoed path is the deployment check: if a host rewrites /api/* to the
  // function but drops the original URL, every route would 404 and this is
  // where that shows up.
  assert.equal(body.path, "/api/health");
});

test("a cron endpoint refuses an unauthenticated call", async () => {
  const response = await get("/api/cron/morning");
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthorized");
});

test("a cron endpoint refuses the wrong secret", async () => {
  const response = await get("/api/cron/evening", { Authorization: "Bearer not-the-secret" });
  assert.equal(response.status, 401);
});

test("a cron endpoint refuses a secret of a different length without leaking that fact", async () => {
  const short = await get("/api/cron/evening", { Authorization: "Bearer x" });
  const long = await get("/api/cron/evening", { Authorization: `Bearer ${"x".repeat(200)}` });
  assert.equal(short.status, 401);
  assert.equal(long.status, 401);
  assert.deepEqual(await short.json(), await long.json());
});

test("the morning job runs when the scheduler presents the right secret", async () => {
  const response = await get("/api/cron/morning", { Authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ran, "morning");
  // Nobody has checked in, so the alert has something to report.
  assert.ok(body.result, "the job should report what it did");
});

test("the evening job runs and reports the shifts it closed", async () => {
  const response = await get("/api/cron/evening", { Authorization: `Bearer ${process.env.CRON_SECRET}` });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ran, "evening");
  assert.ok(Array.isArray(body.result.autoCheckout));
});

test("non-API routes return JSON, not a crash looking for files that aren't bundled", async () => {
  const response = await get("/some/deep/link");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type").includes("application/json"), true);
  assert.equal((await response.json()).error.code, "not_found");
});

test("an unknown API endpoint is a clean 404", async () => {
  const response = await get("/api/nope");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");
});


const post = (path, body) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("one colleague's failed sign-ins do not lock out everyone else on the office network", async () => {
  // Every request here comes from the same address, as it would behind one
  // office router. Ada fails repeatedly and burns her own budget.
  for (let i = 0; i < 12; i += 1) {
    await post("/api/auth/login", { email: "admin@serverless.co", password: "wrong-password" });
  }
  const locked = await post("/api/auth/login", { email: "admin@serverless.co", password: "wrong" });
  assert.equal(locked.status, 429, "repeated failures on one account should be throttled");

  // A colleague on the same network signs in normally.
  const colleague = await post("/api/auth/login", { email: "someone.else@serverless.co", password: "whatever" });
  assert.equal(colleague.status, 401, "a different account must still be answered, not throttled");
});

test("successful sign-ins never spend the failure budget", async () => {
  await employeesService.create({
    name: "Busy Office",
    email: "busy@serverless.co",
    password: "password123",
    mustChangePassword: false,
  });

  // A whole office signing in one after another, far more than the limit.
  for (let i = 0; i < 15; i += 1) {
    const response = await post("/api/auth/login", { email: "busy@serverless.co", password: "password123" });
    assert.equal(response.status, 200, `sign-in ${i + 1} should succeed, not be rate limited`);
  }
});
