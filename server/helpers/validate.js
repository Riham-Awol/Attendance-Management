"use strict";

const { ApiError } = require("./errors");

/**
 * Validate `req[source]` against a Joi schema and replace it with the coerced
 * value, so controllers only ever see clean, typed input.
 */
const validate = (schema, source = "body") => (req, _res, next) => {
  const { error, value } = schema.validate(req[source], {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  if (error) {
    return next(
      ApiError.badRequest(
        error.details.map((d) => d.message).join("; "),
        error.details.map((d) => ({ field: d.path.join("."), message: d.message }))
      )
    );
  }
  // req.query is a getter on Express 5; assigning to a copy keeps both working.
  if (source === "query") {
    req.validatedQuery = value;
  } else {
    req[source] = value;
  }
  next();
};

module.exports = { validate };
