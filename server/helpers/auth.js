"use strict";

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");

const env = require("../config/env");
const { collection, COLLECTIONS } = require("../config/db");
const { ApiError } = require("./errors");

const ROLES = { ADMIN: "admin", EMPLOYEE: "employee" };

const hashPassword = (plain) => bcrypt.hash(plain, 10);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash || "");

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, name: user.name },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

function readToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

/**
 * Authenticate the caller and attach the *current* user document.
 *
 * The user is re-read on every request rather than trusted from the token, so
 * deactivating an employee or demoting an admin takes effect immediately
 * instead of whenever their token happens to expire.
 */
const requireAuth = async (req, _res, next) => {
  try {
    const token = readToken(req);
    if (!token) throw ApiError.unauthorized();

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw ApiError.unauthorized("Your session has expired, please sign in again");
    }

    if (!ObjectId.isValid(payload.sub)) throw ApiError.unauthorized();
    const user = await collection(COLLECTIONS.users).findOne({ _id: new ObjectId(payload.sub) });
    if (!user) throw ApiError.unauthorized("This account no longer exists");
    if (user.status !== "active") throw ApiError.forbidden("This account has been deactivated");

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
  next();
};

const requireAdmin = requireRole(ROLES.ADMIN);

/**
 * Admins may read anyone; employees may only read themselves. Used by routes
 * that take a :userId so one URL serves both audiences safely.
 */
function assertCanAccessUser(req, userId) {
  if (req.user.role === ROLES.ADMIN) return;
  if (String(req.user._id) !== String(userId)) throw ApiError.forbidden();
}

/** Append-only trail of everything an admin changed by hand. */
async function audit(req, action, targetType, targetId, changes = {}) {
  await collection(COLLECTIONS.auditLogs).insertOne({
    actorId: req.user ? req.user._id : null,
    actorName: req.user ? req.user.name : "system",
    action,
    targetType,
    targetId: targetId ? String(targetId) : null,
    changes,
    ip: req.ip,
    at: new Date(),
  });
}

module.exports = {
  ROLES,
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,
  requireAdmin,
  assertCanAccessUser,
  audit,
};
