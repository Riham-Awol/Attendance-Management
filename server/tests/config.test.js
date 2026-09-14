"use strict";

/**
 * A misconfigured deployment must say what is wrong.
 *
 * Configuration is validated when config/env is first required, which happens
 * before Express exists — so without care the platform answers every request
 * with a bare 500 and the person deploying has nothing to go on. These tests
 * run in child processes because the failure is a module-load failure.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

/** Load a module in a clean process with a given environment. */
function loadIn(env, script) {
  try {
    const stdout = execFileSync(process.execPath, ["-e", script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env, DOTENV_CONFIG_PATH: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

const REPORT_CONFIG_ERROR = `
  try {
    require("./server/config/env.js");
    console.log(JSON.stringify({ loaded: true }));
  } catch (err) {
    console.log(JSON.stringify({ code: err.code, message: err.message, problems: err.problems }));
  }
`;

test("a production deployment with no JWT_SECRET names the variable", () => {
  const result = loadIn(
    { NODE_ENV: "production", JWT_SECRET: "", MONGO_URI: "mongodb://x" },
    REPORT_CONFIG_ERROR
  );
  const body = JSON.parse(result.stdout);
  assert.equal(body.code, "configuration_error");
  assert.match(body.message, /JWT_SECRET is not set/);
  // It should point at where to fix it, not just complain.
  assert.match(body.message, /environment settings/);
});

test("a short production JWT_SECRET is rejected with its actual length", () => {
  const result = loadIn(
    { NODE_ENV: "production", JWT_SECRET: "tooshort", MONGO_URI: "mongodb://x" },
    REPORT_CONFIG_ERROR
  );
  const body = JSON.parse(result.stdout);
  assert.equal(body.code, "configuration_error");
  assert.match(body.message, /only 8 characters/);
});

test("a long production secret loads cleanly", () => {
  const result = loadIn(
    { NODE_ENV: "production", JWT_SECRET: "x".repeat(48), MONGO_URI: "mongodb://x" },
    REPORT_CONFIG_ERROR
  );
  assert.deepEqual(JSON.parse(result.stdout), { loaded: true });
});

test("development still runs without a secret configured", () => {
  const result = loadIn({ NODE_ENV: "development", JWT_SECRET: "" }, REPORT_CONFIG_ERROR);
  assert.deepEqual(JSON.parse(result.stdout), { loaded: true });
});

test("the serverless entry answers a misconfiguration with 503 and the reason", () => {
  const script = `
    const handler = require("./api/index.js");
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { console.log(JSON.stringify({ status: this.statusCode, body: JSON.parse(body) })); },
    };
    handler({ url: "/api/auth/login", method: "POST", headers: {} }, res);
  `;
  const result = loadIn(
    { NODE_ENV: "production", VERCEL: "1", JWT_SECRET: "", MONGO_URI: "mongodb://x" },
    script
  );

  const { status, body } = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(status, 503, "a misconfigured deployment must not answer a blank 500");
  assert.equal(body.error.code, "configuration_error");
  assert.match(body.error.message, /JWT_SECRET is not set/);
  assert.deepEqual(body.error.problems, ["JWT_SECRET is not set."]);
});

test("a connection string's password never reaches a response or a log", () => {
  const { redact } = require("../helpers/startup-diagnostics");
  const leaked = "MongoServerError connecting to mongodb+srv://admin:S3cr3t!@cluster0.x.mongodb.net/db";

  const safe = redact(leaked);
  assert.ok(!safe.includes("S3cr3t!"), `password survived redaction: ${safe}`);
  assert.ok(!safe.includes("admin:"), "username and password are removed together");
  // The host is kept — that is the part worth seeing.
  assert.match(safe, /cluster0\.x\.mongodb\.net/);
  assert.match(safe, /<credentials>/);

  // Plain messages are untouched.
  assert.equal(redact("connect ECONNREFUSED 127.0.0.1:27017"), "connect ECONNREFUSED 127.0.0.1:27017");
});

test("each common database misconfiguration gets its own remedy", () => {
  const { describeDatabaseError } = require("../helpers/startup-diagnostics");

  const authError = Object.assign(new Error("bad auth : authentication failed"), { name: "MongoServerError" });
  assert.match(describeDatabaseError(authError).hint, /username or password/);

  const parseError = Object.assign(new Error("Invalid scheme"), { name: "MongoParseError" });
  assert.match(describeDatabaseError(parseError).hint, /valid connection string/);

  const reachError = Object.assign(new Error("connection timed out"), { name: "MongoServerSelectionError" });
  assert.match(describeDatabaseError(reachError).hint, /Network Access/);

  // Anything unrecognised still says something useful rather than nothing.
  assert.match(describeDatabaseError(new Error("something else")).hint, /Check MONGO_URI/);
});

test("the serverless entry reports an unreachable database with a hint, not a bare 503", () => {
  const script = `
    const handler = require("./api/index.js");
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) { console.log(JSON.stringify({ status: this.statusCode, body: JSON.parse(body) })); },
    };
    handler({ url: "/api/auth/login", method: "POST", headers: {} }, res);
  `;
  const result = loadIn(
    {
      NODE_ENV: "production",
      VERCEL: "1",
      JWT_SECRET: "x".repeat(48),
      // A port nothing listens on: server selection fails fast.
      MONGO_URI: "mongodb://127.0.0.1:27099/attendance",
    },
    script
  );

  const { status, body } = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(status, 503);
  assert.equal(body.error.code, "database_unavailable");
  assert.match(body.error.hint, /Network Access|Check MONGO_URI/);
  assert.ok(body.error.detail, "the underlying driver error should be reported");
  assert.ok(!/:.*@/.test(body.error.detail), "no credentials in the detail");
});
