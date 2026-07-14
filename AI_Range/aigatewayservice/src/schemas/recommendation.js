// Mirrors the `recommend_intervention` tool schema the AI decision engine is
// forced to respond through during live adaptation. Kept here (not inline in
// aiEngineClient.js) so the timeline engine's REST/event contract and the
// model's tool-use contract can never silently drift apart - one file, one
// source of truth for "what a recommendation looks like".
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
  // target_id is required for every type except no_action
  if: {
    properties: { recommendation_type: { const: "no_action" } },
  },
  then: {},
  else: { required: ["target_id"] },
};

// Request body for POST /v1/recommendations
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
