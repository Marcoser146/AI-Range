"use strict";

const { randomUUID } = require("crypto");
const config = require("../config");

/**
 * Backing store for the async after-action report path
 * (POST /v1/reports -> 202 + job_id, GET /v1/reports/:job_id to poll).
 *
 * JOB_STORE_MODE=memory (default) is what this always was: fine for a
 * single gateway process, but a job vanishes if the process restarts -
 * which now happens routinely, via the 30-minute ansible-pull convergence
 * cycle (see docs/range-inference-tower.html, "GitOps convergence"). An
 * instructor mid-poll on a report that was 90% done shouldn't lose it to a
 * routine config sync, so production sets JOB_STORE_MODE=postgres instead.
 *
 * Every method is async (even in memory mode) so routes.js can `await`
 * either mode identically without caring which one is active.
 */
function createMemoryJobStore() {
  const jobs = new Map(); // job_id -> { status, result, error, created_at, completed_at }

  async function create(initial = {}) {
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

  async function get(jobId) {
    return jobs.get(jobId) || null;
  }

  async function complete(jobId, result) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "complete";
    job.result = result;
    job.completed_at = new Date().toISOString();
  }

  async function fail(jobId, error) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.error = error;
    job.completed_at = new Date().toISOString();
  }

  return { create, get, complete, fail };
}

function createPostgresJobStore() {
  const db = require("../db"); // lazy require - see src/db.js

  function rowToJob(row) {
    return {
      job_id: row.job_id,
      status: row.status,
      exercise_id: row.exercise_id,
      result: row.result,
      error: row.error,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    };
  }

  async function create(initial = {}) {
    const jobId = randomUUID();
    await db.query(
      `INSERT INTO report_jobs (job_id, status, exercise_id, created_at)
       VALUES ($1, 'pending', $2, now())`,
      [jobId, initial.exercise_id || null]
    );
    return jobId;
  }

  async function get(jobId) {
    const { rows } = await db.query(`SELECT * FROM report_jobs WHERE job_id = $1`, [jobId]);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async function complete(jobId, result) {
    await db.query(
      `UPDATE report_jobs SET status = 'complete', result = $2, completed_at = now() WHERE job_id = $1`,
      [jobId, JSON.stringify(result)]
    );
  }

  async function fail(jobId, error) {
    await db.query(
      `UPDATE report_jobs SET status = 'failed', error = $2, completed_at = now() WHERE job_id = $1`,
      [jobId, String(error)]
    );
  }

  return { create, get, complete, fail };
}

function createJobStore({ mode = config.jobStoreMode } = {}) {
  if (mode === "memory") return createMemoryJobStore();
  if (mode === "postgres") return createPostgresJobStore();
  throw new Error(
    `[ai-gateway] jobStore: unknown JOB_STORE_MODE "${mode}" (expected "memory" or "postgres")`
  );
}

module.exports = { createJobStore };
