"use strict";

const express = require("express");

const config = require("./config");
const aiEngineClient = require("./aiEngineClient");
const { createRouter } = require("./routes");
const { createJobStore } = require("./store/jobStore");
const { createEventAdapter } = require("./eventAdapter");
const { InMemoryBroker } = require("./brokers/inMemoryBroker");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

function createBroker() {
  if (config.eventBrokerMode !== "memory") {
    throw new Error(
      `EVENT_BROKER_MODE="${config.eventBrokerMode}" is not implemented. ` +
        `Only "memory" ships out of the box — see src/brokers/inMemoryBroker.js ` +
        `for the { subscribe, publish } interface a real adapter must satisfy.`
    );
  }
  return new InMemoryBroker();
}

function createApp({ engine = aiEngineClient, jobStore = createJobStore() } = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.use("/v1", createRouter({ engine, jobStore }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function start() {
  const broker = createBroker();
  const eventAdapter = createEventAdapter({
    broker,
    engine: aiEngineClient,
    autoApplyConfidenceThreshold: config.defaultAutoApplyThreshold,
  });
  const stopEventAdapter = eventAdapter.start();

  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[ai-gateway] listening on :${config.port} (broker mode: ${config.eventBrokerMode})`);
  });

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log("[ai-gateway] shutting down");
    stopEventAdapter();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, server, broker, eventAdapter };
}

if (require.main === module) {
  start();
}

module.exports = { createApp, createBroker, start };
