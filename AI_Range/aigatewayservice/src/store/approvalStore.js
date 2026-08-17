"use strict";

const { randomUUID } = require("crypto");
const config = require("../config");

/**
 * approvalStore.js - the persisted approval queue eventAdapter.js writes
 * to whenever it decides a recommendation is pending_approval (see
 * decideApproval() there), and src/routes/admin.js reads/writes for the
 * instructor-facing approve/reject workflow.
 *
 * This closes a real gap in the original design: eventAdapter.js already
 * computed approval_status: "pending_approval" and published it on
 * AIRecommendationGenerated, but nothing persisted the queue or exposed a
 * way to act on it - in a live classroom, that queue is where an
 * instructor's attention actually goes, and it's also where the "call out
 * rejected recommendations" rule in the after-action report prompt gets
 * its data from.
 */
function createMemoryApprovalStore() {
  const items = new Map(); // approval_id -> record

  async function create(record) {
    const approvalId = randomUUID();
    items.set(approvalId, {
      approval_id: approvalId,
      status: "pending_approval",
      created_at: new Date().toISOString(),
      resolved_at: null,
      resolved_by: null,
      ...record,
    });
    return approvalId;
  }

  async function list({ exerciseId, status } = {}) {
    return [...items.values()]
      .filter((r) => !exerciseId || r.exercise_id === exerciseId)
      .filter((r) => !status || r.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async function get(approvalId) {
    return items.get(approvalId) || null;
  }

  async function resolve(approvalId, { status, resolvedBy }) {
    const item = items.get(approvalId);
    if (!item) return null;
    item.status = status;
    item.resolved_by = resolvedBy || null;
    item.resolved_at = new Date().toISOString();
    return item;
  }

  return { create, list, get, resolve };
}

function createPostgresApprovalStore() {
  const db = require("../db"); // lazy require - see src/db.js

  function rowToApproval(row) {
    return {
      approval_id: row.approval_id,
      exercise_id: row.exercise_id,
      student_id: row.student_id,
      recommendation_type: row.recommendation_type,
      target_id: row.target_id,
      confidence: row.confidence,
      rationale: row.rationale,
      reason: row.reason,
      prompt_version: row.prompt_version,
      status: row.status,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      resolved_at: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at,
      resolved_by: row.resolved_by,
    };
  }

  async function create(record) {
    const approvalId = randomUUID();
    await db.query(
      `INSERT INTO approval_queue
         (approval_id, exercise_id, student_id, recommendation_type, target_id,
          confidence, rationale, reason, prompt_version, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_approval', now())`,
      [
        approvalId,
        record.exercise_id || null,
        record.student_id || null,
        record.recommendation_type || null,
        record.target_id || null,
        record.confidence ?? null,
        record.rationale || null,
        record.reason || null,
        record.prompt_version || null,
      ]
    );
    return approvalId;
  }

  async function list({ exerciseId, status } = {}) {
    const conditions = [];
    const params = [];
    if (exerciseId) {
      params.push(exerciseId);
      conditions.push(`exercise_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await db.query(
      `SELECT * FROM approval_queue ${where} ORDER BY created_at DESC`,
      params
    );
    return rows.map(rowToApproval);
  }

  async function get(approvalId) {
    const { rows } = await db.query(`SELECT * FROM approval_queue WHERE approval_id = $1`, [approvalId]);
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  async function resolve(approvalId, { status, resolvedBy }) {
    const { rows } = await db.query(
      `UPDATE approval_queue SET status = $2, resolved_by = $3, resolved_at = now()
       WHERE approval_id = $1 RETURNING *`,
      [approvalId, status, resolvedBy || null]
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  return { create, list, get, resolve };
}

function createApprovalStore({ mode = config.approvalStoreMode } = {}) {
  if (mode === "memory") return createMemoryApprovalStore();
  if (mode === "postgres") return createPostgresApprovalStore();
  throw new Error(
    `[ai-gateway] approvalStore: unknown APPROVAL_STORE_MODE "${mode}" (expected "memory" or "postgres")`
  );
}

module.exports = { createApprovalStore };
