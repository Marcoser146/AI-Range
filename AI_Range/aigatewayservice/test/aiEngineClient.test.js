"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../src/aiEngineClient");
const { validate } = require("../src/schemas/validator");

test("recommendIntervention returns a schema-valid recommendation stamped with prompt/schema version", async () => {
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
  assert.ok(result.attempts >= 1);
});

test("assessActionQuality returns a schema-valid assessment stamped with prompt/schema version", async () => {
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

test("generateAfterActionReport returns a narrative stamped with prompt/schema version", async () => {
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
