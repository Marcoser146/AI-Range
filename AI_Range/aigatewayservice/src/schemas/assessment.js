// Mirrors the `assess_action_quality` tool schema used by the scoring
// engine's AI qualitative assessor. quality_score is a capped 0-1 signal,
// never a raw point value - the score aggregator (outside this service)
// owns turning it into points via the exercise's authored rubric weights.
const QUALITY_DIMENSIONS = ["methodology", "efficiency", "documentation"];

const assessmentOutputSchema = {
  $id: "assessment-output",
  type: "object",
  additionalProperties: false,
  properties: {
    objective_id: { type: "string", minLength: 1 },
    quality_score: { type: "number", minimum: 0, maximum: 1 },
    dimension: { enum: QUALITY_DIMENSIONS },
    evidence: { type: "string" },
    rationale: { type: "string", minLength: 1 },
  },
  required: ["objective_id", "quality_score", "dimension", "rationale"],
};

// Request body for POST /v1/assessments
const assessmentRequestSchema = {
  $id: "assessment-request",
  type: "object",
  additionalProperties: false,
  properties: {
    exercise_id: { type: "string", minLength: 1 },
    student_id: { type: "string", minLength: 1 },
    objective_id: { type: "string", minLength: 1 },
    dimension: { enum: QUALITY_DIMENSIONS },
    action_log: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      minItems: 1,
    },
    submission_text: { type: "string" },
  },
  required: ["exercise_id", "objective_id", "action_log"],
};

module.exports = {
  QUALITY_DIMENSIONS,
  assessmentOutputSchema,
  assessmentRequestSchema,
};
