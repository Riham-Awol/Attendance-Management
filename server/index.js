"use strict";

const env = require("./config/env");
const { connect, close } = require("./config/db");
const { createApp } = require("./app");
const { bootstrapAdmin } = require("./scripts/bootstrap");
const cronJobs = require("./cron/jobs");

async function main() {
  await connect();
  console.log(`[attendance] connected to MongoDB (${env.dbName})`);

  await bootstrapAdmin();
  cronJobs.start();

  const server = createApp().listen(env.port, () => {
    console.log(`[attendance] listening on http://localhost:${env.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`[attendance] ${signal} received, shutting down`);
    server.close(async () => {
      await close();
      process.exit(0);
    });
    // Don't hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // The overwhelmingly common first-run failure is "MongoDB isn't there",
  // and the driver's own error does not say what to do about it.
  if (/ECONNREFUSED|ServerSelection|ENOTFOUND/.test(String(err))) {
    console.error(
      `[attendance] Could not reach MongoDB at ${env.mongoUri}\n` +
        "  - Is MongoDB running? (macOS: brew services start mongodb-community)\n" +
        "  - Or set MONGO_URI in .env to a MongoDB Atlas connection string.\n" +
        `  - Details: ${err.message}`
    );
  } else {
    console.error("[attendance] failed to start:", err);
  }
  process.exit(1);
});
