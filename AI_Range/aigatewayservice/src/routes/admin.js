"use strict";

/*
  routes/admin.js - the instructor-facing surface: the approval queue
  eventAdapter.js writes to (see the approvalStore wiring there), upstream
  health, per-student quota usage, and loading/unloading student LoRA
  adapters into the isolated vllm-lora upstream (see "The adaptation lab"
  in docs/range-inference-tower.html).

  Every route here goes through requireAdminAuth (src/middleware/auth.js):
  either the instructor-dashboard service token, or a chat request whose
  forwarded Open WebUI role is in config.admin.roles.
*/

const express = require("express");

const config = require("../config");
const { ApiError } = require("../middleware/errorHandler");
const { requireAdminAuth } = require("../middleware/auth");

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function findLoraBaseUpstream() {
  const entry = Object.entries(config.upstreams).find(([, u]) => u.lora);
  return entry ? { name: entry[0], ...entry[1] } : null;
}

function createAdminRouter({ approvalStore, upstreams, quota, audit, fetchImpl = (...args) => fetch(...args) }) {
  const router = express.Router();

  // --- approval queue --------------------------------------------------
  router.get(
    "/approvals",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const items = await approvalStore.list({
        exerciseId: req.query.exercise_id,
        status: req.query.status || "pending_approval",
      });
      res.status(200).json({ approvals: items });
    })
  );

  router.get(
    "/approvals/:id",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const item = await approvalStore.get(req.params.id);
      if (!item) throw new ApiError(404, "not_found", `No approval with id ${req.params.id}`);
      res.status(200).json(item);
    })
  );

  async function resolveApproval(req, res, status) {
    const item = await approvalStore.get(req.params.id);
    if (!item) throw new ApiError(404, "not_found", `No approval with id ${req.params.id}`);
    if (item.status !== "pending_approval") {
      throw new ApiError(409, "already_resolved", `Approval ${req.params.id} is already "${item.status}"`);
    }
    const resolvedBy = req.principal?.studentEmail || req.principal?.studentId || req.caller?.name || "unknown";
    const updated = await approvalStore.resolve(req.params.id, { status, resolvedBy });
    res.status(200).json(updated);
  }

  router.post(
    "/approvals/:id/approve",
    requireAdminAuth,
    asyncHandler((req, res) => resolveApproval(req, res, "approved"))
  );

  router.post(
    "/approvals/:id/reject",
    requireAdminAuth,
    asyncHandler((req, res) => resolveApproval(req, res, "rejected"))
  );

  // --- upstream / model health ------------------------------------------
  router.get("/upstreams", requireAdminAuth, (req, res) => {
    res.status(200).json({ upstreams: upstreams.statusReport() });
  });

  // --- quota inspection ---------------------------------------------------
  router.get("/quota/:studentId", requireAdminAuth, (req, res) => {
    const tenant = req.query.tenant || req.principal?.tenant || "default";
    res.status(200).json(quota.usageFor({ tenant, studentId: req.params.studentId }));
  });

  // --- audit lookup (recent inference calls for a student/tenant) --------
  router.get(
    "/audit",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const entries = await audit.list({
        tenant: req.query.tenant,
        studentId: req.query.student_id,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.status(200).json({ entries });
    })
  );

  // --- LoRA adapter admin -------------------------------------------------
  //
  // Loads a student-trained adapter into the isolated vllm-lora upstream
  // and registers it in the model registry under its own name, so it shows
  // up in GET /v1/models for whoever it's scoped to (this route doesn't
  // enforce per-student/cohort visibility on its own - pair it with a
  // tenant/allowedModels update if that scoping is needed).
  router.post(
    "/lora/load",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const { name, path: adapterPath } = req.body || {};
      if (!name || !adapterPath) {
        throw new ApiError(400, "invalid_request", '"name" and "path" are required');
      }

      const base = findLoraBaseUpstream();
      if (!base) throw new ApiError(500, "internal_error", "No LoRA-capable upstream is configured");

      const upstreamRes = await fetchImpl(`${base.baseUrl}/v1/load_lora_adapter`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lora_name: name, lora_path: adapterPath }),
      });
      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => "");
        throw new ApiError(502, "upstream_error", text.slice(0, 500) || `Upstream returned ${upstreamRes.status}`);
      }

      upstreams.registerModel(name, {
        baseUrl: base.baseUrl,
        servedModelName: name,
        healthPath: base.healthPath,
        guidedDecoding: false,
      });

      res.status(200).json({ loaded: name, baseUrl: base.baseUrl });
    })
  );

  router.post(
    "/lora/unload",
    requireAdminAuth,
    asyncHandler(async (req, res) => {
      const { name } = req.body || {};
      if (!name) throw new ApiError(400, "invalid_request", '"name" is required');

      const base = findLoraBaseUpstream();
      if (!base) throw new ApiError(500, "internal_error", "No LoRA-capable upstream is configured");

      const upstreamRes = await fetchImpl(`${base.baseUrl}/v1/unload_lora_adapter`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lora_name: name }),
      });
      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => "");
        throw new ApiError(502, "upstream_error", text.slice(0, 500) || `Upstream returned ${upstreamRes.status}`);
      }

      upstreams.unregisterModel(name);
      res.status(200).json({ unloaded: name });
    })
  );

  return router;
}

module.exports = { createAdminRouter };
