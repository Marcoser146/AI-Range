"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validate } = require("../src/schemas/validator");

test("recommendation-output requires target_id unless no_action", () => {
  const withoutTarget = validate("recommendation-output", {
    recommendation_type: "inject_hint",
    confidence: 0.5,
    rationale: "missing target",
  });
  assert.equal(withoutTarget.valid, false);

  const noAction = validate("recommendation-output", {
    recommendation_type: "no_action",
    confidence: 0.5,
    rationale: "nothing to do",
  });
  assert.equal(noAction.valid, true);

  const withTarget = validate("recommendation-output", {
    recommendation_type: "inject_hint",
    target_id: "hint-1",
    confidence: 0.5,
    rationale: "ok",
  });
  assert.equal(withTarget.valid, true);
});

test("recommendation-output rejects confidence outside [0,1] and unknown types", () => {
  const badConfidence = validate("recommendation-output", {
    recommendation_type: "no_action",
    confidence: 1.5,
    rationale: "bad",
  });
  assert.equal(badConfidence.valid, false);

  const badType = validate("recommendation-output", {
    recommendation_type: "rewrite_exercise",
    confidence: 0.5,
    rationale: "not a real type",
  });
  assert.equal(badType.valid, false);
});

test("assessment-output requires all fields and caps quality_score", () => {
  const missingRationale = validate("assessment-output", {
    objective_id: "obj-1",
    quality_score: 0.5,
    dimension: "methodology",
  });
  assert.equal(missingRationale.valid, false);

  const overCap = validate("assessment-output", {
    objective_id: "obj-1",
    quality_score: 1.2,
    dimension: "methodology",
    rationale: "over cap",
  });
  assert.equal(overCap.valid, false);

  const good = validate("assessment-output", {
    objective_id: "obj-1",
    quality_score: 0.9,
    dimension: "efficiency",
    rationale: "fast and correct",
  });
  assert.equal(good.valid, true);
});
