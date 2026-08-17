"use strict";

const express = require("express");

const config = require("./config");
const aiEngineClient = require("./aiEngineClient");
const { createRouter } = require("./routes");
const { createChatRouter } = require("./chatProxy");
const { createAdminRouter } = require("./routes/admin");
const { createJobStore } = require("./store/jobStore");
const { createApprovalStore } = require("./store/approvalStore");
const { createEventAdapter } = require("./eventAdapter");
const { InMemoryBroker } = require("./brokers/inMemoryBroker");
const { createNatsBroker } = require("./brokers/natsBroker");
const { createUpstreamRegistry } = require("./upstreams");
const { createQuotaTracker } = require("./quota");
const { createAuditLog } = require("./audit");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

function createBroker() {
  if (config.eventBrokerMode === "memory") return new InMemoryBroker();
  if (config.eventBrokerMode === "nats") return createNatsBroker();
  throw new Error(
    `EVENT_BROKER_MODE="${config.eventBrokerMode}" is not implemented. ` +
      `"memory" and "nats" ship out of the box - see src/brokers/inMemoryBroker.js ` +
      `for the { subscribe, publish } interface a real adapter must satisfy.`
  );
}

function createApp({
  engine = aiEngineClient,
  jobStore = createJobStore(),
  upstreamRegistry = createUpstreamRegistry(),
  quotaTracker = createQuotaTracker(),
  auditLog = createAuditLog(),
  approvalStore = createApprovalStore(),
  // Overridable in tests so the chat proxy and admin (LoRA load/unload)
  // routes are exercisable without a live vLLM - production always uses
  // the platform fetch (see the same pattern in aiEngineClient.js).
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // GET /v1/ready - readiness, as opposed to /v1/health's liveness. Reports
  // per-model status so nginx/Open WebUI/monitoring can tell "the process
  // is up" apart from "the models it fronts are actually usable" - the gap
  // that made the original unconditional /v1/health misleading once real
  // vLLM instances (which take minutes to load) sit behind this gateway.
  app.get("/v1/ready", (req, res) => {
    const upstreamStatus = upstreamRegistry.statusReport();
    const anyReady = upstreamStatus.some((u) => u.ready);
    res.status(anyReady ? 200 : 503).json({ ready: anyReady, upstreams: upstreamStatus });
  });

  // Range REST API (control plane, instructor dashboard) and the chat
  // proxy (Open WebUI) both mount at /v1 - see routes.js for why that's
  // safe (auth is attached per-route there, not via a blanket
  // router.use(), so an unmatched range-API path falls through to the
  // chat router below instead of being rejected first).
  app.use("/v1", createRouter({ engine, jobStore }));
  app.use(
    "/v1",
    createChatRouter({ upstreams: upstreamRegistry, quota: quotaTracker, audit: auditLog, fetchImpl })
  );
  app.use(
    "/v1/admin",
    createAdminRouter({
      approvalStore,
      upstreams: upstreamRegistry,
      quota: quotaTracker,
      audit: auditLog,
      fetchImpl,
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function start() {
  const broker = createBroker();
  const upstreamRegistry = createUpstreamRegistry();
  const quotaTracker = createQuotaTracker();
  const auditLog = createAuditLog();
  const jobStore = createJobStore();
  const approvalStore = createApprovalStore();

  const stopUpstreamPolling = upstreamRegistry.start();

  const eventAdapter = createEventAdapter({
    broker,
    engine: aiEngineClient,
    autoApplyConfidenceThreshold: config.defaultAutoApplyThreshold,
    approvalStore,
  });
  const stopEventAdapter = eventAdapter.start();

  const app = createApp({ jobStore, upstreamRegistry, quotaTracker, auditLog, approvalStore });
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[ai-gateway] listening on :${config.port} ` +
        `(broker mode: ${config.eventBrokerMode}, job store: ${config.jobStoreMode}, ` +
        `audit store: ${config.auditStoreMode})`
    );
  });

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log("[ai-gateway] shutting down");
    stopEventAdapter();
    stopUpstreamPolling();
    if (typeof broker.close === "function") broker.close().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, server, broker, eventAdapter, upstreamRegistry };
}

if (require.main === module) {
  start();
}

module.exports = { createApp, createBroker, start };
