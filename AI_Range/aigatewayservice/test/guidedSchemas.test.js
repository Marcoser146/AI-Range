"use strict";

/*
  The guided-decoding schemas in src/schemas/guided.js are hand-maintained
  in parallel with the ajv (if/then/else) schemas in
  src/schemas/recommendation.js and src/schemas/resourceRequest.js, because
  grammar-constrained decoding backends generally don't support
  if/then/else. This test is the tripwire for the two drifting apart: every
  fixture below must agree between the two validators.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const Ajv = require("ajv");

const { validate } = require("../src/schemas/validator");
const {
  guidedRecommendationOutputSchema,
  guidedResourceRequestOutputSchema,
} = require("../src/schemas/guided");

const ajv = new Ajv({ allErrors: true, strict: false });
const validateGuidedRecommendation = ajv.compile(guidedRecommendationOutputSchema);
const validateGuidedResourceRequest = ajv.compile(guidedResourceRequestOutputSchema);

const recommendationFixtures = [
  {
    label: "no_action, valid",
    valid: true,
    obj: { recommendation_type: "no_action", confidence: 0.5, rationale: "steady state" },
  },
  {
    label: "inject_hint with target, valid",
    valid: true,
    obj: {
      recommendation_type: "inject_hint",
      target_id: "hint-1",
      confidence: 0.7,
      rationale: "blocked",
    },
  },
  {
    label: "branch_change with target, valid",
    valid: true,
    obj: {
      recommendation_type: "branch_change",
      target_id: "branch-1",
      confidence: 0.9,
      rationale: "structural",
    },
  },
  {
    label: "non-no_action missing target_id, invalid",
    valid: false,
    obj: { recommendation_type: "inject_hint", confidence: 0.7, rationale: "missing target" },
  },
  {
    label: "no_action with an extra target_id, invalid (additionalProperties/const mismatch)",
    valid: false,
    obj: {
      recommendation_type: "no_action",
      target_id: "should-not-be-here",
      confidence: 0.5,
      rationale: "extra field",
    },
  },
  {
    label: "confidence out of range, invalid",
    valid: false,
    obj: { recommendation_type: "no_action", confidence: 1.2, rationale: "bad" },
  },
  {
    label: "unknown recommendation_type, invalid",
    valid: false,
    obj: { recommendation_type: "rewrite_exercise", confidence: 0.5, rationale: "not real" },
  },
];

const resourceRequestFixtures = [
  { label: "not needed, valid", valid: true, obj: { resource_needed: false } },
  {
    label: "needed with resource + justification, valid",
    valid: true,
    obj: { resource_needed: true, resource: "attacker-vm", justification: "pivot from DC01" },
  },
  {
    label: "needed but missing resource/justification, invalid",
    valid: false,
    obj: { resource_needed: true },
  },
  {
    label: "not needed but resource present, invalid",
    valid: false,
    obj: { resource_needed: false, resource: "attacker-vm", justification: "n/a" },
  },
  {
    label: "unknown resource type, invalid",
    valid: false,
    obj: { resource_needed: true, resource: "moon-base", justification: "n/a" },
  },
];

test("guided recommendation schema agrees with the ajv if/then/else schema", () => {
  for (const fixture of recommendationFixtures) {
    const ajvResult = validate("recommendation-output", fixture.obj);
    const guidedResult = validateGuidedRecommendation(fixture.obj);

    assert.equal(
      ajvResult.valid,
      fixture.valid,
      `fixture "${fixture.label}": expected ajv schema valid=${fixture.valid}, got ${ajvResult.valid} (${ajvResult.errors.join("; ")})`
    );
    assert.equal(
      guidedResult,
      fixture.valid,
      `fixture "${fixture.label}": expected guided schema valid=${fixture.valid}, got ${guidedResult} (${ajv.errorsText(validateGuidedRecommendation.errors)})`
    );
  }
});

test("guided resource-request schema agrees with the ajv if/then/else schema", () => {
  for (const fixture of resourceRequestFixtures) {
    const ajvResult = validate("resource-request-output", fixture.obj);
    const guidedResult = validateGuidedResourceRequest(fixture.obj);

    assert.equal(
      ajvResult.valid,
      fixture.valid,
      `fixture "${fixture.label}": expected ajv schema valid=${fixture.valid}, got ${ajvResult.valid} (${ajvResult.errors.join("; ")})`
    );
    assert.equal(
      guidedResult,
      fixture.valid,
      `fixture "${fixture.label}": expected guided schema valid=${fixture.valid}, got ${guidedResult} (${ajv.errorsText(validateGuidedResourceRequest.errors)})`
    );
  }
});
