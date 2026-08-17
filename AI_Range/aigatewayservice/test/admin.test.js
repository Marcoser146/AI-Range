"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

process.env.AI_GATEWAY_API_KEY = "test-key";
process.env.INSTRUCTOR_DASHBOARD_TOKEN = "dash-token";
process.env.TENANTS_JSON = JSON.stringify({
  default: { token: "default-token", allowedModels: null },
});

const { createApp } = require("../src/server");
const { createApprovalStore } = require("../src/store/approvalStore");
const { createQuotaTracker } = require("../src/quota");

const DASHBOARD_AUTH = { Authorization: "Bearer dash-token" };
const ADMIN_ROLE_HEADERS = {
  Authorization: "Bearer default-token",
  "X-OpenWebUI-User-Id": "instructor-1",
  "X-OpenWebUI-User-Role": "admin",
};
const STUDENT_ROLE_HEADERS = {
  Authorization: "Bearer default-token",
  "X-OpenWebUI-User-Id": "student-1",
  "X-OpenWebUI-User-Role": "user",
};

function fakeUpstreamRegistry() {
  return {
    listModels: () => [],
    getUpstream: () => null,
    isReady: () => false,
    statusReport: () => [{ id: "gpt-oss-120b", ready: true }, { id: "granite-3.3-8b", ready: false }],
    registerModel: () => {},
    unregisterModel: () => {},
  };
}

test("GET /v1/admin/approvals requires auth", async () => {
  const app = createApp({ upstreamRegistry: fakeUpstreamRegistry() });
  const res = await request(app).get("/v1/admin/approvals");
  assert.equal(res.status, 401);
});

test("a student role (not admin/instructor) is rejected from admin routes", async () => {
  const app = createApp({ upstreamRegistry: fakeUpstreamRegistry() });
  const res = await request(app).get("/v1/admin/approvals").set(STUDENT_ROLE_HEADERS);
  assert.equal(res.status, 403);
});

test("the instructor-dashboard service token and an admin-role chat request both work", async () => {
  const approvalStore = createApprovalStore();
  await approvalStore.create({ exercise_id: "ex-1", recommendation_type: "branch_change" });
  const app = createApp({ approvalStore, upstreamRegistry: fakeUpstreamRegistry() });

  const viaDashboard = await request(app).get("/v1/admin/approvals").set(DASHBOARD_AUTH);
  assert.equal(viaDashboard.status, 200);
  assert.equal(viaDashboard.body.approvals.length, 1);

  const viaAdminRole = await request(app).get("/v1/admin/approvals").set(ADMIN_ROLE_HEADERS);
  assert.equal(viaAdminRole.status, 200);
  assert.equal(viaAdminRole.body.approvals.length, 1);
});

test("GET /v1/admin/approvals defaults to pending_approval only", async () => {
  const approvalStore = createApprovalStore();
  const pendingId = await approvalStore.create({ exercise_id: "ex-1" });
  const otherId = await approvalStore.create({ exercise_id: "ex-2" });
  await approvalStore.resolve(otherId, { status: "approved", resolvedBy: "instr@example.edu" });

  const app = createApp({ approvalStore, upstreamRegistry: fakeUpstreamRegistry() });
  const res = await request(app).get("/v1/admin/approvals").set(DASHBOARD_AUTH);

  assert.equal(res.status, 200);
  assert.equal(res.body.approvals.length, 1);
  assert.equal(res.body.approvals[0].approval_id, pendingId);
});

test("approve/reject resolve a pending approval and reject a second resolution", async () => {
  const approvalStore = createApprovalStore();
  const id = await approvalStore.create({ exercise_id: "ex-1", recommendation_type: "difficulty_adjust" });
  const app = createApp({ approvalStore, upstreamRegistry: fakeUpstreamRegistry() });

  const approve = await request(app).post(`/v1/admin/approvals/${id}/approve`).set(DASHBOARD_AUTH);
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, "approved");

  const again = await request(app).post(`/v1/admin/approvals/${id}/reject`).set(DASHBOARD_AUTH);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "already_resolved");
});

test("resolving an unknown approval id returns 404", async () => {
  const app = createApp({ upstreamRegistry: fakeUpstreamRegistry() });
  const res = await request(app).post("/v1/admin/approvals/does-not-exist/approve").set(DASHBOARD_AUTH);
  assert.equal(res.status, 404);
});

test("GET /v1/admin/upstreams reports readiness per model", async () => {
  const app = createApp({ upstreamRegistry: fakeUpstreamRegistry() });
  const res = await request(app).get("/v1/admin/upstreams").set(DASHBOARD_AUTH);
  assert.equal(res.status, 200);
  const gptoss = res.body.upstreams.find((u) => u.id === "gpt-oss-120b");
  assert.equal(gptoss.ready, true);
});

test("GET /v1/admin/quota/:studentId reports recorded usage", async () => {
  const quotaTracker = createQuotaTracker({ tokensPerHourPerStudent: 1000 });
  quotaTracker.recordUsage({ tenant: "default", studentId: "student-118", tokens: 250 });
  const app = createApp({ quotaTracker, upstreamRegistry: fakeUpstreamRegistry() });

  const res = await request(app)
    .get("/v1/admin/quota/student-118?tenant=default")
    .set(DASHBOARD_AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.body.studentTokensThisHour, 250);
});

test("POST /v1/admin/lora/load calls the LoRA base upstream and registers the model", async () => {
  let capturedUrl;
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  let registered = null;
  const upstreamRegistry = {
    ...fakeUpstreamRegistry(),
    registerModel: (name, entry) => {
      registered = { name, entry };
    },
  };
  const app = createApp({ upstreamRegistry, fetchImpl });

  const res = await request(app)
    .post("/v1/admin/lora/load")
    .set(DASHBOARD_AUTH)
    .send({ name: "student-118-run-3", path: "/srv/airange/adapters/cohort3/student-118/run-3" });

  assert.equal(res.status, 200);
  assert.match(capturedUrl, /\/v1\/load_lora_adapter$/);
  assert.equal(capturedBody.lora_name, "student-118-run-3");
  assert.equal(registered.name, "student-118-run-3");
});

test("POST /v1/admin/lora/load without a name or path is rejected", async () => {
  const app = createApp({ upstreamRegistry: fakeUpstreamRegistry() });
  const res = await request(app).post("/v1/admin/lora/load").set(DASHBOARD_AUTH).send({});
  assert.equal(res.status, 400);
});
