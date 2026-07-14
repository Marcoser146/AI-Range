"use strict";

/** Every error response takes the shape { error: { code, message } }. */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  // eslint-disable-next-line no-console
  console.error("[ai-gateway] unhandled error:", err);
  res.status(500).json({ error: { code: "internal_error", message: "Unexpected error" } });
}

module.exports = { ApiError, notFoundHandler, errorHandler };
