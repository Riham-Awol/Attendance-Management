"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const env = require("./config/env");
const { errorHandler, ApiError } = require("./helpers/errors");

function createApp() {
  const app = express();

  // Behind a PaaS reverse proxy, this is what makes req.ip (and therefore the
  // rate limiter and audit trail) reflect the real client.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      // The PWA is served from this same origin with inline bootstrap script;
      // everything else stays locked to self.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    cors(
      env.corsOrigins.length
        ? { origin: env.corsOrigins, credentials: true }
        : // Same-origin by default: the API serves its own PWA, so no CORS is
          // needed until someone hosts the frontend elsewhere.
          { origin: false }
    )
  );

  app.use(express.json({ limit: "200kb" }));
  app.use(express.urlencoded({ extended: false }));

  app.use(
    "/api",
    rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false })
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use("/api/auth", require("./modules/auth/auth.routes"));
  app.use("/api/employees", require("./modules/employees/employees.routes"));
  app.use("/api/attendance", require("./modules/attendance/attendance.routes"));
  app.use("/api/leaves", require("./modules/leave/leave.routes"));
  app.use("/api/settings", require("./modules/settings/settings.routes"));
  app.use("/api/reports", require("./modules/reports/reports.routes"));
  app.use("/api/dashboard", require("./modules/dashboard/dashboard.routes"));
  app.use("/api/cron", require("./modules/cron/cron.routes"));

  app.use("/api", (_req, _res, next) => next(ApiError.notFound("No such endpoint")));

  // On a serverless host the platform serves the PWA straight from its CDN and
  // only /api/* ever reaches this function, so there are no static files to
  // hand out here — and no index.html in the bundle to fall back on.
  if (env.isServerless) {
    app.use((_req, _res, next) => next(ApiError.notFound("No such endpoint")));
    app.use(errorHandler);
    return app;
  }

  // The PWA itself. The service worker must not be cached or an update can
  // never reach a phone that already installed the app.
  const webRoot = path.join(__dirname, "..", "web");
  app.get("/service-worker.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webRoot, "service-worker.js"));
  });
  app.use(express.static(webRoot, { index: "index.html", maxAge: "1h" }));
  app.get("*", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
