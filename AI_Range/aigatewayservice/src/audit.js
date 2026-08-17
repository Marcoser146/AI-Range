"use strict";

const config = require("./config");

/**
 * audit.js - the compliance backbone for the chat path: one record per
 * inference call, tying a model response back to exactly who asked for it
 * (tenant + student), on which exercise, against which model and prompt
 * version, with how many tokens and how long it took.
 *
 * This is what turns "a student says the assistant told them something
 * inappropriate" or "prove what happened during an assessed exercise" from
 * an unanswerable question into a lookup. It also feeds the
 * fallback-rate/prompt-version-drift alerts described in
 * docs/range-inference-tower.html ("Observability and acceptance tests").
 *
 * AUDIT_STORE_MODE=memory (default, dev/test) keeps a ring buffer in
 * process memory - fine for exercising the chat proxy locally, useless as
 * an actual audit trail since it's gone on restart. Production sets
 * AUDIT_STORE_MODE=postgres.
 */
function createMemoryAuditLog({ capacity = 5000 } = {}) {
  const entries = [];

  async function record(entry) {
    entries.push({ ...entry, recorded_at: new Date().toISOString() });
    if (entries.length > capacity) entries.shift();
  }

  async function list({ tenant, studentId, limit = 100 } = {}) {
    return entries
      .filter((e) => !tenant || e.tenant === tenant)
      .filter((e) => !studentId || e.studentId === studentId)
      .slice(-limit)
      .reverse();
  }

  return { record, list };
}

function createPostgresAuditLog() {
  const db = require("./db"); // lazy require - see src/db.js

  async function record(entry) {
    await db.query(
      `INSERT INTO inference_audit
         (tenant, student_id, exercise_id, mode, model, prompt_tokens,
          completion_tokens, latency_ms, finish_reason, prompt_version, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [
        entry.tenant || null,
        entry.studentId || null,
        entry.exerciseId || null,
        entry.mode || null,
        entry.model || null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        entry.latencyMs ?? null,
        entry.finishReason || null,
        entry.promptVersion || null,
      ]
    );
  }

  async function list({ tenant, studentId, limit = 100 } = {}) {
    const conditions = [];
    const params = [];
    if (tenant) {
      params.push(tenant);
      conditions.push(`tenant = $${params.length}`);
    }
    if (studentId) {
      params.push(studentId);
      conditions.push(`student_id = $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query(
      `SELECT * FROM inference_audit ${where} ORDER BY recorded_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  return { record, list };
}

function createAuditLog({ mode = config.auditStoreMode } = {}) {
  if (mode === "memory") return createMemoryAuditLog();
  if (mode === "postgres") return createPostgresAuditLog();
  throw new Error(`[ai-gateway] audit: unknown AUDIT_STORE_MODE "${mode}" (expected "memory" or "postgres")`);
}

module.exports = { createAuditLog };
