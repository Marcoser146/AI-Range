"use strict";

const config = require("./config");

/**
 * quota.js - keeps one student's runaway chat loop (or one cohort's class
 * period) from starving everyone else sharing the same GPU.
 *
 * Two independent limits:
 *   - a rolling-hour token budget, per student and per tenant (checked
 *     before a request goes out, recorded after it completes with the
 *     actual usage vLLM reports)
 *   - a concurrent-stream cap, per student (checked/held for the lifetime
 *     of a streaming response, so one student can't open ten tabs and run
 *     ten generations at once)
 *
 * In-memory only, which is the right call for a single-process gateway on
 * one tower - see src/store/jobStore.js for the same reasoning applied to
 * report jobs. If the gateway ever runs as more than one replica, this
 * needs to move to something shared (Redis, or the same Postgres instance
 * as the audit log) the same way that file's header note says.
 */
function createQuotaTracker({
  tokensPerHourPerStudent = config.quota.tokensPerHourPerStudent,
  tokensPerHourPerTenant = config.quota.tokensPerHourPerTenant,
  maxConcurrentStreamsPerStudent = config.quota.maxConcurrentStreamsPerStudent,
  now = () => Date.now(),
} = {}) {
  const WINDOW_MS = 60 * 60 * 1000;
  const studentUsage = new Map(); // studentId -> { windowStart, tokens }
  const tenantUsage = new Map(); // tenant -> { windowStart, tokens }
  const activeStreams = new Map(); // studentId -> count

  function currentWindow(map, key) {
    const t = now();
    const entry = map.get(key);
    if (!entry || t - entry.windowStart >= WINDOW_MS) {
      const fresh = { windowStart: t, tokens: 0 };
      map.set(key, fresh);
      return fresh;
    }
    return entry;
  }

  /** Call before sending a request upstream. */
  function checkBudget({ tenant, studentId }) {
    const student = currentWindow(studentUsage, studentId);
    if (student.tokens >= tokensPerHourPerStudent) {
      return { allowed: false, reason: "student_token_budget_exceeded" };
    }
    const tenantEntry = currentWindow(tenantUsage, tenant);
    if (tenantEntry.tokens >= tokensPerHourPerTenant) {
      return { allowed: false, reason: "tenant_token_budget_exceeded" };
    }
    return { allowed: true };
  }

  /** Call after a request completes, with the actual token usage. */
  function recordUsage({ tenant, studentId, tokens }) {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    currentWindow(studentUsage, studentId).tokens += tokens;
    currentWindow(tenantUsage, tenant).tokens += tokens;
  }

  /** Reserve a concurrent-stream slot; returns { allowed, end? }. */
  function beginStream({ studentId }) {
    const count = activeStreams.get(studentId) || 0;
    if (count >= maxConcurrentStreamsPerStudent) {
      return { allowed: false, reason: "too_many_concurrent_streams" };
    }
    activeStreams.set(studentId, count + 1);
    let released = false;
    return {
      allowed: true,
      end: () => {
        if (released) return; // idempotent - a stream can end via both "close" and "error"
        released = true;
        endStream({ studentId });
      },
    };
  }

  function endStream({ studentId }) {
    const count = activeStreams.get(studentId) || 0;
    activeStreams.set(studentId, Math.max(0, count - 1));
  }

  function usageFor({ tenant, studentId }) {
    return {
      studentTokensThisHour: studentUsage.get(studentId)?.tokens || 0,
      tenantTokensThisHour: tenantUsage.get(tenant)?.tokens || 0,
      activeStreams: activeStreams.get(studentId) || 0,
      limits: { tokensPerHourPerStudent, tokensPerHourPerTenant, maxConcurrentStreamsPerStudent },
    };
  }

  return { checkBudget, recordUsage, beginStream, endStream, usageFor };
}

module.exports = { createQuotaTracker };
