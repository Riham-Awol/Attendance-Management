"use strict";

const express = require("express");
const crypto = require("crypto");

const env = require("../../config/env");
const { asyncHandler, ApiError } = require("../../helpers/errors");
const jobs = require("../../cron/jobs");

const router = express.Router();

/**
 * Scheduled jobs on a serverless host arrive as plain HTTP requests, so the
 * URL alone must not be enough to trigger them: anyone could hit
 * /api/cron/evening repeatedly and auto-close everybody's shift.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that variable is
 * set on the project. Without a configured secret these endpoints refuse to
 * run at all rather than standing open.
 */
function requireCronSecret(req, _res, next) {
  const expected = env.cron.secret;
  if (!expected) {
    return next(
      new ApiError(
        503,
        "cron_not_configured",
        "Set CRON_SECRET on the deployment before the scheduled jobs can run."
      )
    );
  }

  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(provided, expected)) throw ApiError.unauthorized("Invalid cron credentials");

  next();
}

/** Constant-time compare, so a wrong secret can't be found byte by byte. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

router.use(requireCronSecret);

router.get(
  "/morning",
  asyncHandler(async (_req, res) => {
    res.json({ ran: "morning", at: new Date().toISOString(), result: await jobs.runMorningJobs() });
  })
);

router.get(
  "/evening",
  asyncHandler(async (_req, res) => {
    res.json({ ran: "evening", at: new Date().toISOString(), result: await jobs.runEveningJobs() });
  })
);

module.exports = router;
