"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../src/aiEngineClient");
const { validate } = require("../src/schemas/validator");

// aiEngineClient.js talks to vLLM over HTTP (fetch). These tests never hit
// a real network - they install a scripted fake fetch via
// engine.__setFetchImpl() so the retry/fallback/validation logic in
// aiEngineClient.js is exercised the same way it would be against a real
// vLLM instance, without needing one running.

function chatCompletionResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "",
  };
}

function jsonContentResponse(obj) {
  return chatCompletionResponse(JSON.stringify(obj));
}

// Returns a fetch-shaped function that replays `steps` in order (functions
// are invoked, Errors are thrown, everything else is returned as-is), and
// repeats the last step once the list is exhausted.
function scriptedFetch(steps) {
  let i = 0;
  return async (...args) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(...args);
    return step;
  };
}

test("recommendIntervention returns a schema-valid recommendation stamped with prompt/schema version", async () => {
  engine.__setFetchImpl(
    scriptedFetch([jsonContentResponse({ recommendation_type: "no_action", confidence: 0.6, rationale: "steady state" })])
  );

  const result = await engine.recommendIntervention({
    exerciseId: "ex-1",
    studentId: "s-1",
    snapshot: {
      exercise_id: "ex-1",
      objectives: [{ id: "obj-1", status: "in_progress", blocked_minutes: 12 }],
    },
  });

  const check = validate("recommendation-output", result.recommendation);
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.equal(result.promptVersion, engine.LIVE_ADAPTATION_SYSTEM_PROMPT_VERSION);
  assert.equal(result.attempts, 1);
});

test("recommendIntervention retries once on invalid model output, then succeeds", async () => {
  engine.__setFetchImpl(
    scriptedFetch([
      jsonContentResponse({ recommendation_type: "no_action", confidence: 0.5 }), // missing rationale - invalid
      jsonContentResponse({ recommendation_type: "no_action", confidence: 0.5, rationale: "ok on retry" }),
    ])
  );

  const result = await engine.recommendIntervention({
    exerciseId: "ex-1",
    snapshot: { exercise_id: "ex-1", objectives: [{ id: "obj-1", blocked_minutes: 12 }] },
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.recommendation.rationale, "ok on retry");
});

test("recommendIntervention falls back to no_action after two invalid attempts", async () => {
  engine.__setFetchImpl(
    scriptedFetch([jsonContentResponse({ recommendation_type: "no_action", confidence: 0.5 })]) // always missing rationale
  );

  const result = await engine.recommendIntervention({
    exerciseId: "ex-1",
    studentId: "s-1",
    snapshot: { exercise_id: "ex-1", objectives: [{ id: "obj-1", blocked_minutes: 12 }] },
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.fallback, true);
  assert.equal(result.recommendation.recommendation_type, "no_action");
  assert.equal(result.recommendation.confidence, 0);
});

test("recommendIntervention falls back to no_action when the upstream call itself fails", async () => {
  engine.__setFetchImpl(scriptedFetch([new Error("connect ECONNREFUSED 127.0.0.1:8003")]));

  const result = await engine.recommendIntervention({
    exerciseId: "ex-1",
    snapshot: { exercise_id: "ex-1", objectives: [{ id: "obj-1", blocked_minutes: 12 }] },
  });

  const check = validate("recommendation-output", result.recommendation);
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.equal(result.fallback, true);
});

test("assessActionQuality returns a schema-valid assessment stamped with prompt/schema version", async () => {
  engine.__setFetchImpl(
    scriptedFetch([
      jsonContentResponse({
        objective_id: "obj-1",
        quality_score: 0.7,
        dimension: "methodology",
        evidence: "used nmap then metasploit in a coherent sequence",
        rationale: "clear systematic approach",
      }),
    ])
  );

  const result = await engine.assessActionQuality({
    exerciseId: "ex-1",
    studentId: "s-1",
    objectiveId: "obj-1",
    actionLog: [{ command: "nmap -sV DC01" }],
  });

  const check = validate("assessment-output", result.assessment);
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.equal(result.promptVersion, engine.ASSESSMENT_SYSTEM_PROMPT_VERSION);
});

test("evaluateResourceNeeds returns a schema-valid resource request stamped with prompt/schema version", async () => {
  engine.__setFetchImpl(scriptedFetch([jsonContentResponse({ resource_needed: false })]));

  const result = await engine.evaluateResourceNeeds({
    exerciseId: "ex-1",
    studentId: "s-1",
    snapshot: { exercise_id: "ex-1", objectives: [{ id: "obj-1", status: "in_progress" }] },
  });

  const check = validate("resource-request-output", result.resourceRequest);
  assert.equal(check.valid, true, check.errors.join("; "));
  assert.equal(result.promptVersion, engine.CAPACITY_ANALYTICS_SYSTEM_PROMPT_VERSION);
  assert.ok(result.attempts >= 1);
});

test("evaluateResourceNeeds returns a resource_needed:true request when the model asks for one", async () => {
  engine.__setFetchImpl(
    scriptedFetch([
      jsonContentResponse({
        resource_needed: true,
        resource: "attacker-vm",
        justification: "simulating pivot from DC01",
      }),
    ])
  );

  const result = await engine.evaluateResourceNeeds({
    exerciseId: "ex-1",
    snapshot: { exercise_id: "ex-1", objectives: [{ id: "obj-1", status: "in_progress" }] },
  });

  assert.equal(result.resourceRequest.resource_needed, true);
  assert.equal(result.resourceRequest.resource, "attacker-vm");
});

test("generateAfterActionReport returns a narrative stamped with prompt/schema version", async () => {
  engine.__setFetchImpl(
    scriptedFetch([chatCompletionResponse("Objective obj-1 was completed efficiently with minimal trial-and-error.")])
  );

  const result = await engine.generateAfterActionReport({
    exerciseId: "ex-1",
    stateSnapshots: [{ exercise_id: "ex-1", elapsed_minutes: 60 }],
    recommendations: [],
    assessments: [],
    finalScores: { "s-1": 82 },
  });

  assert.equal(typeof result.narrative, "string");
  assert.ok(result.narrative.length > 0);
  assert.equal(result.promptVersion, engine.REPORT_SYSTEM_PROMPT_VERSION);
});

test("generateAfterActionReport propagates an error when the upstream call fails", async () => {
  engine.__setFetchImpl(scriptedFetch([new Error("connect ECONNREFUSED 127.0.0.1:8000")]));

  await assert.rejects(
    engine.generateAfterActionReport({
      exerciseId: "ex-1",
      stateSnapshots: [],
      recommendations: [],
      assessments: [],
      finalScores: {},
    })
  );
});

after(() => {
  engine.__resetFetchImpl();
});
