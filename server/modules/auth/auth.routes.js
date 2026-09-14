"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { asyncHandler, ApiError } = require("../../helpers/errors");
const { validate } = require("../../helpers/validate");
const schemas = require("../../helpers/schemas");
const {
  verifyPassword,
  signToken,
  hashPassword,
  requireAuth,
} = require("../../helpers/auth");
const { collection, COLLECTIONS } = require("../../config/db");
const { publicUser } = require("../employees/employees.service");
const settingsService = require("../settings/settings.service");

const router = express.Router();

// Password guessing is the one attack this app is really exposed to.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "too_many_attempts", message: "Too many sign-in attempts. Try again in 15 minutes." } },
});

router.post(
  "/login",
  loginLimiter,
  validate(schemas.login),
  asyncHandler(async (req, res) => {
    const user = await collection(COLLECTIONS.users).findOne({ email: req.body.email });
    // Same message either way: revealing which half was wrong helps an attacker
    // enumerate staff emails.
    const invalid = ApiError.unauthorized("Incorrect email or password");
    if (!user) {
      // Spend the bcrypt time anyway so response timing doesn't leak whether
      // the account exists.
      await verifyPassword(req.body.password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu");
      throw invalid;
    }
    if (!(await verifyPassword(req.body.password, user.password))) throw invalid;
    if (user.status !== "active") throw ApiError.forbidden("This account has been deactivated");

    await collection(COLLECTIONS.users).updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date() } }
    );

    res.json({
      token: signToken(user),
      user: publicUser(user),
      settings: await publicSettings(),
    });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user), settings: await publicSettings() });
  })
);

router.post(
  "/change-password",
  requireAuth,
  validate(schemas.changePassword),
  asyncHandler(async (req, res) => {
    if (!(await verifyPassword(req.body.currentPassword, req.user.password))) {
      throw ApiError.badRequest("Your current password is not correct");
    }
    await collection(COLLECTIONS.users).updateOne(
      { _id: req.user._id },
      {
        $set: {
          password: await hashPassword(req.body.newPassword),
          mustChangePassword: false,
          updatedAt: new Date(),
        },
      }
    );
    res.json({ ok: true });
  })
);

/** Settings safe to hand any signed-in employee. */
async function publicSettings() {
  const settings = await settingsService.getSettings();
  return {
    companyName: settings.companyName,
    timeZone: settings.timeZone,
    geo: settings.geo,
  };
}

module.exports = router;
