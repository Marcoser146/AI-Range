"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createUpstreamRegistry } = require("../src/upstreams");

const SAMPLE_UPSTREAMS = {
  "model-a": { baseUrl: "http://a.internal", servedModelName: "model-a", healthPath: "/health" },
  "model-b": { baseUrl: "http://b.internal", servedModelName: "model-b", healthPath: "/health" },
  "embed-model": {
    baseUrl: "http://embed.internal",
    servedModelName: "embed-model",
    healthPath: "/health",
    embedding: true,
  },
};

function fetchThatReports(healthyUrls) {
  return async (url) => ({ ok: healthyUrls.some((h) => url.startsWith(h)) });
}

test("pollAll marks each upstream ready/not-ready based on its health response", async () => {
  const registry = createUpstreamRegistry({
    upstreams: SAMPLE_UPSTREAMS,
    fetchImpl: fetchThatReports(["http://a.internal"]),
  });

  await registry.pollAll();

  assert.equal(registry.isReady("model-a"), true);
  assert.equal(registry.isReady("model-b"), false);
});

test("a model is not-ready before its first poll (fail closed, not open)", () => {
  const registry = createUpstreamRegistry({ upstreams: SAMPLE_UPSTREAMS, fetchImpl: fetchThatReports([]) });
  assert.equal(registry.isReady("model-a"), false);
});

test("a network error during polling marks the upstream not-ready rather than throwing", async () => {
  const registry = createUpstreamRegistry({
    upstreams: SAMPLE_UPSTREAMS,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await assert.doesNotReject(registry.pollAll());
  assert.equal(registry.isReady("model-a"), false);
});

test("listModels excludes embedding models and filters by readiness and tenant allowlist", async () => {
  const registry = createUpstreamRegistry({
    upstreams: SAMPLE_UPSTREAMS,
    fetchImpl: fetchThatReports(["http://a.internal", "http://b.internal", "http://embed.internal"]),
  });
  await registry.pollAll();

  const all = registry.listModels();
  assert.deepEqual(
    all.map((m) => m.id).sort(),
    ["model-a", "model-b"]
  );

  const restricted = registry.listModels({ allowedModels: ["model-a"] });
  assert.deepEqual(restricted.map((m) => m.id), ["model-a"]);
});

test("listModels omits a model that hasn't answered its health check yet", async () => {
  const registry = createUpstreamRegistry({
    upstreams: SAMPLE_UPSTREAMS,
    fetchImpl: fetchThatReports(["http://a.internal"]),
  });
  await registry.pollAll();

  const ready = registry.listModels();
  assert.deepEqual(ready.map((m) => m.id), ["model-a"]);
});

test("registerModel adds a new model (e.g. a hot-loaded LoRA adapter) and unregisterModel removes it", async () => {
  const registry = createUpstreamRegistry({
    upstreams: SAMPLE_UPSTREAMS,
    fetchImpl: fetchThatReports(["http://lora.internal"]),
  });

  registry.registerModel("student-adapter-1", {
    baseUrl: "http://lora.internal",
    servedModelName: "student-adapter-1",
    healthPath: "/health",
  });
  await new Promise((resolve) => setImmediate(resolve)); // let registerModel's own pollOne() settle

  assert.ok(registry.getUpstream("student-adapter-1"));
  assert.equal(registry.isReady("student-adapter-1"), true);

  registry.unregisterModel("student-adapter-1");
  assert.equal(registry.getUpstream("student-adapter-1"), null);
});

test("statusReport lists every configured upstream with its readiness", async () => {
  const registry = createUpstreamRegistry({
    upstreams: SAMPLE_UPSTREAMS,
    fetchImpl: fetchThatReports(["http://a.internal"]),
  });
  await registry.pollAll();

  const report = registry.statusReport();
  const a = report.find((r) => r.id === "model-a");
  const b = report.find((r) => r.id === "model-b");
  assert.equal(a.ready, true);
  assert.equal(b.ready, false);
});
