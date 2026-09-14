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
