"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.AI_GATEWAY_API_KEY = "test-key";
const { createApp } = require("../src/server");

const app = createApp();
const AUTH = { Authorization: "Bearer test-key" };

test("GET /v1/health requires no auth", async () => {
  const res = await request(app).get("/v1/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("protected routes reject missing/invalid auth", async () => {
  const missing = await request(app).post("/v1/recommendations").send({});
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, "unauthorized");

  const invalid = await request(app)
    .post("/v1/recommendations")
    .set("Authorization", "Bearer wrong-key")
    .send({});
  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.error.code, "forbidden");
});

test("POST /v1/recommendations validates the request body", async () => {
  const res = await request(app).post("/v1/recommendations").set(AUTH).send({ exercise_id: "ex-1" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "invalid_request");
});

test("POST /v1/recommendations returns a recommendation for a valid request", async () => {
  const res = await request(app)
    .post("/v1/recommendations")
    .set(AUTH)
    .send({
      exercise_id: "ex-4471",
      student_id: "s-118",
      snapshot: {
        exercise_id: "ex-4471",
        objectives: [{ id: "obj-2", status: "in_progress", blocked_minutes: 12 }],
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.exercise_id, "ex-4471");
  assert.ok(res.body.recommendation);
  assert.ok(res.body.prompt_version);
});

test("POST /v1/recommendations replays a cached response for a repeated Idempotency-Key", async () => {
  const body = {
    exercise_id: "ex-idem",
    snapshot: { exercise_id: "ex-idem", objectives: [] },
  };

  const first = await request(app)
    .post("/v1/recommendations")
    .set(AUTH)
    .set("Idempotency-Key", "abc-123")
    .send(body);
  const second = await request(app)
    .post("/v1/recommendations")
    .set(AUTH)
    .set("Idempotency-Key", "abc-123")
    .send(body);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers["idempotency-replayed"], "true");
  assert.deepEqual(first.body, second.body);
});

test("POST /v1/assessments returns an assessment for a valid request", async () => {
  const res = await request(app)
    .post("/v1/assessments")
    .set(AUTH)
    .send({
      exercise_id: "ex-4471",
      objective_id: "obj-2",
      action_log: [{ command: "nmap -sV DC01" }],
    });

  assert.equal(res.status, 200);
  assert.ok(res.body.assessment);
});

test("POST /v1/reports starts a job and GET /v1/reports/:id resolves it", async () => {
  const created = await request(app)
    .post("/v1/reports")
    .set(AUTH)
    .send({ exercise_id: "ex-4471" });

  assert.equal(created.status, 202);
  assert.ok(created.body.job_id);
  assert.equal(created.body.status, "pending");

  // report generation resolves asynchronously - poll briefly
  let job;
  for (let i = 0; i < 20; i += 1) {
    const polled = await request(app).get(`/v1/reports/${created.body.job_id}`).set(AUTH);
    job = polled.body;
    if (job.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(job.status, "complete");
  assert.ok(job.result.narrative);
});

test("GET /v1/reports/:id for an unknown job returns 404", async () => {
  const res = await request(app).get("/v1/reports/does-not-exist").set(AUTH);
  assert.equal(res.status, 404);
});
