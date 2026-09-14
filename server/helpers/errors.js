"use strict";

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, "bad_request", message, details);
  }
  static unauthorized(message = "Please sign in to continue") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "You do not have access to this") {
    return new ApiError(403, "forbidden", message);
  }
  static notFound(message = "Not found") {
    return new ApiError(404, "not_found", message);
  }
  static conflict(message, details) {
    return new ApiError(409, "conflict", message, details);
  }
}

/** Wrap an async route so a rejected promise reaches the error handler. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error("[attendance] unhandled error", err);
  }
  res.status(status).json({
    error: {
      code: err.code || "server_error",
      message: status >= 500 ? "Something went wrong on our side" : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

module.exports = { ApiError, asyncHandler, errorHandler };
