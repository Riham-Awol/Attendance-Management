"use strict";

/**
 * Vercel serverless entry point.
 *
 * Only /api/* is routed here (see vercel.json); the PWA itself is served from
 * Vercel's CDN. There is no boot step on a serverless platform, so the work
 * index.js does at startup — connecting to MongoDB and making sure an admin
 * account exists — happens once per cold instance, before the first request.
 *
 * Loading is wrapped in try/catch on purpose. Configuration is validated when
 * config/env is first required, so a missing variable would otherwise throw
 * before Express exists and the platform would answer every request with a
 * bare 500 — no message, nothing to act on. Catching it here turns that into a
 * response that says which variable is wrong.
 */

let startupError = null;
let app = null;
let connect = null;
let bootstrapAdmin = null;
let isServerless = false;

try {
  const { createApp } = require("../server/app");
  ({ connect } = require("../server/config/db"));
  ({ bootstrapAdmin } = require("../server/scripts/bootstrap"));
  ({ isServerless } = require("../server/config/env"));
  app = createApp();
} catch (err) {
  console.error("[attendance] startup failed:", err);
  startupError = err;
}

let ready;

function prepare() {
  if (!ready) {
    ready = (async () => {
      await connect();
      await bootstrapAdmin();
    })().catch((err) => {
      // Don't cache a failed start: a database that was briefly unreachable
      // would otherwise keep this instance broken until it is recycled.
      ready = undefined;
      throw err;
    });
  }
  return ready;
}

const fail = (res, status, code, message, extra = {}) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: { code, message, ...extra } }));
};

module.exports = async (req, res) => {
  if (startupError) {
    // A configuration problem is the deployer's to fix and says nothing secret
    // — only which variables are missing — so it is safe and useful to return.
    if (startupError.code === "configuration_error") {
      return fail(res, 503, "configuration_error", startupError.message, {
        problems: startupError.problems,
      });
    }
    return fail(
      res,
      500,
      "startup_failed",
      "The server failed to start. Check the deployment logs for the cause."
    );
  }

  try {
    await prepare();
  } catch (err) {
    console.error("[attendance] could not reach the database:", err);
    return fail(
      res,
      503,
      "database_unavailable",
      "The server could not reach its database. Check MONGO_URI, and that this deployment's IP is allowed in MongoDB Atlas (Network Access → 0.0.0.0/0)."
    );
  }

  return app(req, res);
};
