// Mirrors the `recommend_intervention` tool schema the AI decision engine is
// forced to respond through during live adaptation. It lives here instead
// of inline in aiEngineClient.js so the timeline engine's REST/event
// contract and the model's tool-use contract can't quietly drift apart -
// one file, one source of truth for what a recommendation looks like.
const RECOMMENDATION_TYPES = [
  "inject_hint",
  "difficulty_adjust",
  "branch_change",
  "extend_time",
  "no_action",
];

const recommendationOutputSchema = {
  $id: "recommendation-output",
  type: "object",
  additionalProperties: false,
  properties: {
    recommendation_type: { enum: RECOMMENDATION_TYPES },
    target_id: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", minLength: 1 },
  },
  required: ["recommendation_type", "confidence", "rationale"],
  // every type requires target_id except no_action, which must not carry
  // one at all (a target_id on a no_action recommendation is a modeling
  // error worth catching, not just noise to ignore).
  if: {
    properties: { recommendation_type: { const: "no_action" } },
  },
  then: { not: { required: ["target_id"] } },
  else: { required: ["target_id"] },
};

// request body for POST /v1/recommendations
const recommendationRequestSchema = {
  $id: "recommendation-request",
  type: "object",
  additionalProperties: false,
  properties: {
    exercise_id: { type: "string", minLength: 1 },
    student_id: { type: "string", minLength: 1 },
    snapshot: {
      type: "object",
      additionalProperties: true,
      required: ["exercise_id", "objectives"],
    },
    scenario_constraints: { type: "object", additionalProperties: true },
    recent_recommendations: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      default: [],
    },
  },
  required: ["exercise_id", "snapshot"],
};

module.exports = {
  RECOMMENDATION_TYPES,
  recommendationOutputSchema,
  recommendationRequestSchema,
};
