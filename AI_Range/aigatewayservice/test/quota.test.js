"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createQuotaTracker } = require("../src/quota");

test("checkBudget allows usage under the per-student limit and blocks over it", () => {
  const quota = createQuotaTracker({
    tokensPerHourPerStudent: 1000,
    tokensPerHourPerTenant: 1_000_000,
    maxConcurrentStreamsPerStudent: 5,
  });

  assert.equal(quota.checkBudget({ tenant: "t1", studentId: "s1" }).allowed, true);

  quota.recordUsage({ tenant: "t1", studentId: "s1", tokens: 999 });
  assert.equal(quota.checkBudget({ tenant: "t1", studentId: "s1" }).allowed, true);

  quota.recordUsage({ tenant: "t1", studentId: "s1", tokens: 1 });
  const blocked = quota.checkBudget({ tenant: "t1", studentId: "s1" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "student_token_budget_exceeded");
});

test("one student's usage does not affect another student's budget", () => {
  const quota = createQuotaTracker({
    tokensPerHourPerStudent: 100,
    tokensPerHourPerTenant: 1_000_000,
    maxConcurrentStreamsPerStudent: 5,
  });

  quota.recordUsage({ tenant: "t1", studentId: "s1", tokens: 100 });
  assert.equal(quota.checkBudget({ tenant: "t1", studentId: "s1" }).allowed, false);
  assert.equal(quota.checkBudget({ tenant: "t1", studentId: "s2" }).allowed, true);
});

test("tenant-level budget blocks even when the individual student is under their own limit", () => {
  const quota = createQuotaTracker({
    tokensPerHourPerStudent: 1_000_000,
    tokensPerHourPerTenant: 100,
    maxConcurrentStreamsPerStudent: 5,
  });

  quota.recordUsage({ tenant: "t1", studentId: "s1", tokens: 100 });
  const result = quota.checkBudget({ tenant: "t1", studentId: "s2" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "tenant_token_budget_exceeded");
});

test("token budget resets after the rolling window elapses", () => {
  let now = 0;
  const quota = createQuotaTracker({
    tokensPerHourPerStudent: 100,
    tokensPerHourPerTenant: 1_000_000,
    maxConcurrentStreamsPerStudent: 5,
    now: () => now,
  });

  quota.recordUsage({ tenant: "t1", studentId: "s1", tokens: 100 });
  assert.equal(quota.checkBudget({ tenant: "t1", studentId: "s1" }).allowed, false);

  now += 60 * 60 * 1000 + 1; // just past the 1-hour window
  assert.equal(quota.checkBudget({ tenant: "t1", studentId: "s1" }).allowed, true);
});

test("beginStream enforces the concurrent-stream cap and end() releases the slot", () => {
  const quota = createQuotaTracker({
    tokensPerHourPerStudent: 1_000_000,
    tokensPerHourPerTenant: 1_000_000,
    maxConcurrentStreamsPerStudent: 2,
  });

  const first = quota.beginStream({ studentId: "s1" });
  const second = quota.beginStream({ studentId: "s1" });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);

  const third = quota.beginStream({ studentId: "s1" });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "too_many_concurrent_streams");

  first.end();
  const fourth = quota.beginStream({ studentId: "s1" });
  assert.equal(fourth.allowed, true);
});

test("beginStream().end() is idempotent", () => {
  const quota = createQuotaTracker({ maxConcurrentStreamsPerStudent: 1 });
  const handle = quota.beginStream({ studentId: "s1" });
  handle.end();
  handle.end(); // should not release a second, nonexistent slot
  assert.equal(quota.usageFor({ studentId: "s1" }).activeStreams, 0);
});

test("usageFor reports current counters and configured limits", () => {
  const quota = createQuotaTracker({
    tokensPerHourPerStudent: 500,
    tokensPerHourPerTenant: 5000,
    maxConcurrentStreamsPerStudent: 3,
  });
  quota.recordUsage({ tenant: "t1", studentId: "s1", tokens: 42 });

  const usage = quota.usageFor({ tenant: "t1", studentId: "s1" });
  assert.equal(usage.studentTokensThisHour, 42);
  assert.equal(usage.tenantTokensThisHour, 42);
  assert.equal(usage.limits.tokensPerHourPerStudent, 500);
});
