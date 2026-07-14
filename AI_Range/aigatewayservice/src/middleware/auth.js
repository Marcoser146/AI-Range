"use strict";

const config = require("../config");

/**
 * Bearer-token check for every /v1/* route except /v1/health.
 * Swap for your control plane's real identity/secret-management story in
 * production — this is the one place a real deployment needs its own auth.
 */
function requireAuth(req, res, next) {
  if (config.authDisabled) return next();

  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      error: { code: "unauthorized", message: "Missing or malformed Authorization header" },
    });
  }

  if (token !== config.apiKey) {
    return res.status(403).json({
      error: { code: "forbidden", message: "Invalid API key" },
    });
  }

  next();
}

module.exports = { requireAuth };
