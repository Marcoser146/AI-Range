"use strict";

const express = require("express");

const { validate } = require("./schemas/validator");
const { ApiError } = require("./middleware/errorHandler");
const { createIdempotencyStore } = require("./middleware/idempotency");
const { requireServiceAuth } = require("./middleware/auth");

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * @param {object} deps
 * @param {import('./aiEngineClient')} deps.engine
 * @param {ReturnType<typeof import('./store/jobStore').createJobStore>} deps.jobStore
 */
function createRouter({ engine, jobStore }) {
  const router = express.Router();
  const recommendationIdempotency = createIdempotencyStore();

  // GET /v1/health - liveness check, no auth required.
  router.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "ai-gateway", time: new Date().toISOString() });
  });

  // Auth is attached per-route (not via a blanket router.use()) so that
  // when this router and the chat proxy router (src/chatProxy.js) are both
  // mounted at /v1, a request for a chat-proxy path (e.g.
  // /v1/chat/completions) that doesn't match any route below falls through
  // to the chat proxy's router instead of being rejected here first.

  // POST /v1/recommendations - synchronous live-adaptation call. Used by
  // the instructor dashboard for on-demand recommendations, and by
  // integration tests that don't want to stand up a broker. The automated
  // loop goes through eventAdapter.js on StateSnapshotUpdated instead.
  router.post(
    "/recommendations",
    requireServiceAuth,
    recommendationIdempotency.middleware,
    asyncHandler(async (req, res) => {
      const check = validate("recommendation-request", req.body);
      if (!check.valid) {
        throw new ApiError(400, "invalid_request", check.errors.join("; "));
      }

      const result = await engine.recommendIntervention({
        exerciseId: req.body.exercise_id,
        studentId: req.body.student_id,
        snapshot: req.body.snapshot,
        scenarioConstraints: req.body.scenario_constraints,
        recentRecommendations: req.body.recent_recommendations,
      });

      res.status(200).json({
        exercise_id: req.body.exercise_id,
        student_id: req.body.student_id,
        recommendation: result.recommendation,
        prompt_version: result.promptVersion,
        schema_version: result.schemaVersion,
        attempts: result.attempts,
        generated_at: new Date().toISOString(),
      });
    })
  );

  // POST /v1/assessments - synchronous qualitative-scoring call, one objective at a time.
  router.post(
    "/assessments",
    requireServiceAuth,
    asyncHandler(async (req, res) => {
      const check = validate("assessment-request", req.body);
      if (!check.valid) {
        throw new ApiError(400, "invalid_request", check.errors.join("; "));
      }

      const result = await engine.assessActionQuality({
        exerciseId: req.body.exercise_id,
        studentId: req.body.student_id,
        objectiveId: req.body.objective_id,
        dimension: req.body.dimension,
        actionLog: req.body.action_log,
        submissionText: req.body.submission_text,
      });

      res.status(200).json({
        exercise_id: req.body.exercise_id,
        student_id: req.body.student_id,
        assessment: result.assessment,
        prompt_version: result.promptVersion,
        schema_version: result.schemaVersion,
        attempts: result.attempts,
        generated_at: new Date().toISOString(),
      });
    })
  );

  // POST /v1/reports - kicks off an after-action report job (EP4). This is
  // async because report generation doesn't have a real-time latency budget
  // and can take a while.
  router.post(
    "/reports",
    requireServiceAuth,
    asyncHandler(async (req, res) => {
      const check = validate("report-request", req.body);
      if (!check.valid) {
        throw new ApiError(400, "invalid_request", check.errors.join("; "));
      }

      const jobId = await jobStore.create({ exercise_id: req.body.exercise_id });

      // From the HTTP handler's point of view this is fire-and-forget - the
      // client polls GET /v1/reports/:job_id to find out when it's done.
      // jobStore.complete/fail are awaited inside their own callbacks (not
      // by this handler) so a slow write to Postgres never holds up the
      // 202 response below.
      engine
        .generateAfterActionReport({
          exerciseId: req.body.exercise_id,
          stateSnapshots: req.body.state_snapshots,
          recommendations: req.body.recommendations,
          assessments: req.body.assessments,
          finalScores: req.body.final_scores,
        })
        .then((result) => jobStore.complete(jobId, result))
        .catch((err) => jobStore.fail(jobId, err.message || "report generation failed"));

      res.status(202).json({
        job_id: jobId,
        status: "pending",
        poll_url: `/v1/reports/${jobId}`,
      });
    })
  );

  // GET /v1/reports/:job_id - poll for report status/result.
  router.get(
    "/reports/:jobId",
    requireServiceAuth,
    asyncHandler(async (req, res) => {
      const job = await jobStore.get(req.params.jobId);
      if (!job) {
        throw new ApiError(404, "not_found", `No report job with id ${req.params.jobId}`);
      }
      res.status(200).json(job);
    })
  );

  return router;
}

module.exports = { createRouter };
