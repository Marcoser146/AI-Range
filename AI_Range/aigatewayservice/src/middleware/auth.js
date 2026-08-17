"use strict";

const config = require("../config");

/**
 * Two independent auth checks live in this file, because the gateway has
 * two independent classes of caller (see README):
 *
 *   - requireServiceAuth - the range control plane and the instructor
 *     dashboard, calling the original REST API (POST /v1/recommendations,
 *     /v1/assessments, /v1/reports). Each trusted service gets its own
 *     named bearer token (config.services), checked here exactly the way
 *     the original single-shared-secret requireAuth() worked.
 *
 *   - requireChatAuth - Open WebUI, calling the OpenAI-compatible chat
 *     surface (src/chatProxy.js) on behalf of a student. The bearer token
 *     here is a static per-enclave token (config.tenants) that identifies
 *     *which enclave* the request came from - Open WebUI itself already
 *     did the real per-student login (via its own OIDC config), so the
 *     student's identity is trusted from the X-OpenWebUI-User-* headers
 *     Open WebUI forwards (ENABLE_FORWARD_USER_INFO_HEADERS=true), not
 *     re-authenticated here. That's a reasonable trust boundary because the
 *     enclave token is exactly what proves the request came from *our*
 *     Open WebUI instance and not directly from a student's browser.
 */

function findTenantByToken(token) {
  for (const [id, entry] of Object.entries(config.tenants)) {
    if (entry && entry.token && entry.token === token) return { id, ...entry };
  }
  return null;
}

function parseBearer(req) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/** Bearer-token check for the range REST API (control plane, dashboard). */
function requireServiceAuth(req, res, next) {
  if (config.authDisabled) {
    req.caller = { type: "service", name: "dev" };
    return next();
  }

  const token = parseBearer(req);
  if (!token) {
    return res.status(401).json({
      error: { code: "unauthorized", message: "Missing or malformed Authorization header" },
    });
  }

  const match = Object.entries(config.services).find(([, value]) => value && value === token);
  if (!match) {
    return res.status(403).json({
      error: { code: "forbidden", message: "Invalid API key" },
    });
  }

  req.caller = { type: "service", name: match[0] };
  next();
}

/** Bearer-token (tenant) + forwarded-header (student) check for chat. */
function requireChatAuth(req, res, next) {
  if (config.authDisabled) {
    req.principal = {
      tenant: "default",
      studentId: req.get("x-openwebui-user-id") || "dev-student",
      studentEmail: req.get("x-openwebui-user-email") || null,
      studentName: req.get("x-openwebui-user-name") || null,
      role: req.get("x-openwebui-user-role") || "user",
      allowedModels: null,
    };
    return next();
  }

  const token = parseBearer(req);
  if (!token) {
    return res.status(401).json({
      error: { code: "unauthorized", message: "Missing or malformed Authorization header" },
    });
  }

  const tenant = findTenantByToken(token);
  if (!tenant) {
    return res.status(403).json({
      error: { code: "forbidden", message: "Invalid API key" },
    });
  }

  const studentId = req.get("x-openwebui-user-id");
  if (!studentId) {
    return res.status(401).json({
      error: {
        code: "missing_student_identity",
        message:
          'Request carried a valid tenant token but no "X-OpenWebUI-User-Id" header - ' +
          "enable ENABLE_FORWARD_USER_INFO_HEADERS on the Open WebUI instance for this tenant.",
      },
    });
  }

  req.principal = {
    tenant: tenant.id,
    studentId,
    studentEmail: req.get("x-openwebui-user-email") || null,
    studentName: req.get("x-openwebui-user-name") || null,
    role: req.get("x-openwebui-user-role") || "user",
    allowedModels: tenant.allowedModels || null,
  };
  next();
}

/**
 * Admin routes (approval queue, quota inspection, LoRA adapter admin) are
 * reachable two ways: the instructor dashboard's service token, or a chat
 * request whose forwarded role is in config.admin.roles (an instructor
 * signed into Open WebUI itself). Either is sufficient on its own.
 */
function requireAdminAuth(req, res, next) {
  if (config.authDisabled) {
    req.caller = { type: "service", name: "dev" };
    return next();
  }

  const token = parseBearer(req);
  if (!token) {
    return res.status(401).json({
      error: { code: "unauthorized", message: "Missing or malformed Authorization header" },
    });
  }

  if (config.services["instructor-dashboard"] && token === config.services["instructor-dashboard"]) {
    req.caller = { type: "service", name: "instructor-dashboard" };
    return next();
  }

  const tenant = findTenantByToken(token);
  if (!tenant) {
    return res.status(403).json({
      error: { code: "forbidden", message: "Invalid API key" },
    });
  }

  const role = req.get("x-openwebui-user-role") || "user";
  if (!config.admin.roles.includes(role)) {
    return res.status(403).json({
      error: { code: "forbidden", message: `Role "${role}" is not permitted to access admin routes` },
    });
  }

  req.principal = {
    tenant: tenant.id,
    studentId: req.get("x-openwebui-user-id") || null,
    studentEmail: req.get("x-openwebui-user-email") || null,
    studentName: req.get("x-openwebui-user-name") || null,
    role,
  };
  next();
}

module.exports = {
  requireServiceAuth,
  requireChatAuth,
  requireAdminAuth,
  // backward-compat alias: this is what the file used to export, and
  // routes.js originally imported it under this name.
  requireAuth: requireServiceAuth,
};
