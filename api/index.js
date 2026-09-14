"use strict";

/**
 * Vercel serverless entry point.
 *
 * Only /api/* is routed here (see vercel.json); the PWA itself is served from
 * Vercel's CDN. There is no boot step on a serverless platform, so the work
 * that index.js does at startup — connecting to MongoDB and making sure an
 * admin account exists — happens once per cold instance, before the first
 * request is handled.
 */

const { createApp } = require("../server/app");
const { connect } = require("../server/config/db");
const { bootstrapAdmin } = require("../server/scripts/bootstrap");

const app = createApp();

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

module.exports = async (req, res) => {
  try {
    await prepare();
  } catch (err) {
    console.error("[attendance] startup failed:", err);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          code: "database_unavailable",
          message:
            "The server could not reach its database. Check MONGO_URI, and that this deployment's IP is allowed in MongoDB Atlas.",
        },
      })
    );
    return;
  }

  return app(req, res);
};
