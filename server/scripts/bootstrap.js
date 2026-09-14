"use strict";

const env = require("../config/env");
const { collection, COLLECTIONS } = require("../config/db");
const { hashPassword, ROLES } = require("../helpers/auth");
const settingsService = require("../modules/settings/settings.service");
const { DEFAULT_SHIFT } = require("../domain/attendance-rules");

/**
 * Make sure a fresh database can be logged into: one admin, one shift, one
 * settings document. Everything here is idempotent, so it is safe on every boot.
 */
async function bootstrapAdmin() {
  await settingsService.getSettings();

  const shiftCount = await collection(COLLECTIONS.shifts).countDocuments();
  if (shiftCount === 0) {
    await settingsService.createShift({
      ...DEFAULT_SHIFT,
      name: "Standard (9–5)",
      breakMinutes: 60,
      isDefault: true,
    });
    console.log("[attendance] created the default shift");
  }

  const adminCount = await collection(COLLECTIONS.users).countDocuments({ role: ROLES.ADMIN });
  if (adminCount > 0) return null;

  const { name, email, password } = env.bootstrapAdmin;
  const defaultShift = await settingsService.getDefaultShift();
  await collection(COLLECTIONS.users).insertOne({
    name,
    email,
    password: await hashPassword(password),
    role: ROLES.ADMIN,
    department: "Management",
    status: "active",
    shiftId: defaultShift._id || null,
    // Forces the password change screen on first sign-in, so the bootstrap
    // credential from the env file cannot quietly stay in use.
    mustChangePassword: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log(`[attendance] created the first admin account: ${email}`);
  if (password === "ChangeMe123!") {
    console.warn("[attendance] WARNING: using the default admin password — change it at first sign-in");
  }
  return email;
}

module.exports = { bootstrapAdmin };
