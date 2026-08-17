"use strict";

/*
  Guided-decoding variants of the output schemas in recommendation.js,
  resourceRequest.js, and assessment.js.

  vLLM (and most other grammar-constrained decoding backends) compile a JSON
  Schema into a token-level grammar, and only implement a subset of the
  spec - `if`/`then`/`else` conditionals are generally not part of that
  subset. recommendation-output and resource-request-output both use
  if/then/else to express "field X is required unless field Y has a
  specific value," which a grammar compiler will typically reject or
  silently ignore.

  The fix is to express the same constraint as `oneOf` over concrete
  branches instead - something every grammar backend supports, because it's
  just "pick one of these fixed shapes." ajv validates fine against oneOf
  too, but we keep the original if/then/else schemas as the source of truth
  for ajv (src/schemas/validator.js) and only use these oneOf variants for
  the request_format sent to the model. test/guidedSchemas.test.js asserts
  the two stay equivalent, since they are hand-maintained in parallel.

  assessment-output has no conditional logic, so it's reused as-is (with
  $id stripped, since a top-level $id in an inline response_format schema
  is unnecessary and some backends are stricter about extra keywords than
  ajv is).
*/

const { RECOMMENDATION_TYPES } = require("./recommendation");
const { RESOURCE_TYPES } = require("./resourceRequest");
const { assessmentOutputSchema } = require("./assessment");

// Strips the ajv-only $id keyword before handing a schema to a model as a
// response_format. Never mutates the input.
function forGuidedDecoding(schema) {
  const { $id, ...rest } = schema;
  void $id;
  return rest;
}

const guidedRecommendationOutputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        recommendation_type: { const: "no_action" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string", minLength: 1 },
      },
      required: ["recommendation_type", "confidence", "rationale"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        recommendation_type: {
          enum: RECOMMENDATION_TYPES.filter((t) => t !== "no_action"),
        },
        target_id: { type: "string", minLength: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string", minLength: 1 },
      },
      required: ["recommendation_type", "target_id", "confidence", "rationale"],
    },
  ],
};

const guidedResourceRequestOutputSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        resource_needed: { const: false },
      },
      required: ["resource_needed"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        resource_needed: { const: true },
        resource: { enum: RESOURCE_TYPES },
        justification: { type: "string", minLength: 1 },
      },
      required: ["resource_needed", "resource", "justification"],
    },
  ],
};

const guidedAssessmentOutputSchema = forGuidedDecoding(assessmentOutputSchema);

module.exports = {
  forGuidedDecoding,
  guidedRecommendationOutputSchema,
  guidedResourceRequestOutputSchema,
  guidedAssessmentOutputSchema,
};
