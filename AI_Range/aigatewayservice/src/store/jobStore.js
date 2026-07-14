"use strict";

const { randomUUID } = require("crypto");

/**
 * Backing store for the async after-action report path
 * (POST /v1/reports -> 202 + job_id, GET /v1/reports/:job_id to poll).
 * In-memory only — swap for a real job table/queue (e.g. Postgres row +
 * a worker, or a durable queue) once this runs outside a single process.
 */
function createJobStore() {
  const jobs = new Map(); // job_id -> { status, result, error, createdAt, completedAt }

  function create(initial = {}) {
    const jobId = randomUUID();
    jobs.set(jobId, {
      job_id: jobId,
      status: "pending",
      result: null,
      error: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      ...initial,
    });
    return jobId;
  }

  function get(jobId) {
    return jobs.get(jobId) || null;
  }

  function complete(jobId, result) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "complete";
    job.result = result;
    job.completed_at = new Date().toISOString();
  }

  function fail(jobId, error) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.error = error;
    job.completed_at = new Date().toISOString();
  }

  return { create, get, complete, fail };
}

module.exports = { createJobStore };
