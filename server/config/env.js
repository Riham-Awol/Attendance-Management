"use strict";

require("dotenv").config();

const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const isProduction = process.env.NODE_ENV === "production";

// A weak JWT secret is the difference between "attendance app" and "anyone can
// mint an admin token", so refuse to boot on the placeholder in production.
const JWT_SECRET = required("JWT_SECRET", isProduction ? undefined : "dev-only-insecure-secret");
if (isProduction && JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters in production");
}

module.exports = {
  isProduction,
  port: Number(process.env.PORT || 4000),
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017"),
  dbName: process.env.DB_NAME || "office_attendance",
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  // Every date and shift time in the app is interpreted in this zone.
  defaultTimeZone: process.env.DEFAULT_TIMEZONE || "Africa/Addis_Ababa",
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  bootstrapAdmin: {
    name: process.env.ADMIN_NAME || "System Admin",
    email: (process.env.ADMIN_EMAIL || "admin@office.local").toLowerCase(),
    password: process.env.ADMIN_PASSWORD || "ChangeMe123!",
  },
  cron: {
    enabled: process.env.CRON_ENABLED !== "false",
    // Minutes after a shift ends before an open check-in is auto-closed.
    autoCheckoutGraceMinutes: Number(process.env.AUTO_CHECKOUT_GRACE_MINUTES || 120),
  },
  mail: {
    enabled: process.env.SMTP_HOST ? true : false,
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || "Attendance <no-reply@office.local>",
  },
};
