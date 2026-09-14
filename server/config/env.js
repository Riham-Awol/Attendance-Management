"use strict";

require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";
// On Vercel (and any other serverless host) there is no long-lived process:
// no in-process cron, and connection pools must be kept small.
const isServerless = !!process.env.VERCEL;

/**
 * Every configuration problem, gathered before anything is thrown.
 *
 * Reporting them one at a time turns a first deployment into several rounds of
 * "fix one variable, redeploy, discover the next".
 */
const problems = [];

const required = (name, fallback) => {
  // An empty variable is not a value: `JWT_SECRET=` in a .env file must fall
  // back the same way an absent one does, which `??` would not do.
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : raw;
  if (value === undefined || value === "") {
    problems.push(`${name} is not set.`);
    return "";
  }
  return value;
};

// A weak JWT secret is the difference between "attendance app" and "anyone can
// mint an admin token", so refuse to boot on the placeholder in production.
const JWT_SECRET = required("JWT_SECRET", isProduction ? undefined : "dev-only-insecure-secret");
if (isProduction && JWT_SECRET && JWT_SECRET.length < 32) {
  problems.push(
    `JWT_SECRET is only ${JWT_SECRET.length} characters; production requires at least 32.`
  );
}

const config = {
  isProduction,
  isServerless,
  port: Number(process.env.PORT || 4000),
  // Localhost is a sensible default when developing and a trap anywhere else:
  // a deployed app that quietly tries 127.0.0.1 reports "cannot reach the
  // database" and sends you hunting through your cluster's settings, when the
  // real problem is that the variable was never set.
  mongoUri: required(
    "MONGO_URI",
    isProduction || isServerless ? undefined : "mongodb://127.0.0.1:27017"
  ),
  dbName: process.env.DB_NAME || "office_attendance",
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  // Failed sign-ins allowed per account, per network, per 15 minutes.
  loginAttemptLimit: Number(process.env.LOGIN_ATTEMPT_LIMIT || 10),
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
    // In-process cron only makes sense where a process stays up. On a
    // serverless host the jobs are driven by scheduled HTTP calls instead.
    enabled: process.env.CRON_ENABLED !== "false" && !isServerless,
    // Shared secret Vercel Cron sends as `Authorization: Bearer …`, so the job
    // endpoints cannot be triggered by anyone who guesses the URL.
    secret: process.env.CRON_SECRET || "",
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

// Checked only once the whole configuration above has been read, so a single
// failure reports every problem rather than the first one encountered.
if (problems.length > 0) {
  const error = new Error(
    `The server is not configured correctly:\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      `\n\nSet these in your host's environment settings` +
      (isServerless ? " (Vercel: Project → Settings → Environment Variables), then redeploy." : ".") +
      `\nGenerate a secret with:` +
      `\n  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
  );
  error.code = "configuration_error";
  error.problems = problems;
  throw error;
}

module.exports = config;
