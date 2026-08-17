"use strict";

const config = require("./config");

/**
 * upstreams.js - the registry of vLLM (and vLLM-compatible) processes on
 * the tower: logical model name -> { baseUrl, servedModelName, ... } plus
 * whether each one is currently answering its /health endpoint.
 *
 * Two things read this:
 *   - aiEngineClient.js resolves its four MODEL_TIERS from it at startup
 *     (see resolveTier() there) - that lookup is static, decided once.
 *   - chatProxy.js resolves a student's requested `model` from it on every
 *     request, and uses isReady()/listModels() to keep Open WebUI's model
 *     picker honest - GET /v1/models should never list a model that isn't
 *     actually answering right now.
 *
 * Student LoRA adapters (src/routes/admin.js) register/unregister
 * themselves here at runtime via registerModel()/unregisterModel(), since
 * they come and go independently of the static, Ansible-managed model set.
 */
function createUpstreamRegistry({
  upstreams = config.upstreams,
  pollIntervalMs = config.upstreamPollIntervalMs,
  healthTimeoutMs = config.upstreamHealthTimeoutMs,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const models = { ...upstreams };
  const health = new Map(); // logical name -> boolean, absent until first poll
  let timer = null;

  async function pollOne(name) {
    const entry = models[name];
    if (!entry) return;
    try {
      const res = await fetchImpl(`${entry.baseUrl}${entry.healthPath || "/health"}`, {
        signal: AbortSignal.timeout(healthTimeoutMs),
      });
      health.set(name, res.ok);
    } catch {
      health.set(name, false);
    }
  }

  async function pollAll() {
    await Promise.all(Object.keys(models).map(pollOne));
  }

  function isReady(name) {
    return health.get(name) === true;
  }

  function getUpstream(name) {
    return models[name] || null;
  }

  // GET /v1/models: chat-eligible (non-embedding), tenant-allowed, and
  // currently healthy - in that order, so a student's model picker only
  // ever shows something they're both allowed to use and can actually use
  // right now.
  function listModels({ allowedModels, readyOnly = true } = {}) {
    return Object.entries(models)
      .filter(([, entry]) => !entry.embedding)
      .filter(([name]) => !allowedModels || allowedModels.includes(name))
      .filter(([name]) => !readyOnly || isReady(name))
      .map(([name]) => ({ id: name, object: "model", owned_by: "ai-range", created: 0 }));
  }

  function registerModel(name, entry) {
    models[name] = entry;
    health.set(name, false);
    // don't block the caller on the first health check
    pollOne(name);
  }

  function unregisterModel(name) {
    delete models[name];
    health.delete(name);
  }

  function statusReport() {
    return Object.keys(models).map((name) => ({
      id: name,
      baseUrl: models[name].baseUrl,
      servedModelName: models[name].servedModelName,
      ready: isReady(name),
    }));
  }

  function start() {
    pollAll(); // don't wait a full interval for the first status
    timer = setInterval(pollAll, pollIntervalMs);
    if (timer.unref) timer.unref();
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    pollAll,
    pollOne,
    isReady,
    getUpstream,
    listModels,
    registerModel,
    unregisterModel,
    statusReport,
  };
}

module.exports = { createUpstreamRegistry };
