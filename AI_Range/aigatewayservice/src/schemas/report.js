// Request body for POST /v1/reports (EP4 after-action report generation).
// This path is async - see src/store/jobStore.js - so there is no output
// schema here, only the request shape. The engine's narrative output is
// stored as free-form markdown/text in the job record.
const reportRequestSchema = {
  $id: "report-request",
  type: "object",
  additionalProperties: false,
  properties: {
    exercise_id: { type: "string", minLength: 1 },
    mode: { const: "post_exercise_report" },
    state_snapshots: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    recommendations: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    assessments: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    final_scores: { type: "object", additionalProperties: true },
  },
  required: ["exercise_id"],
};

module.exports = { reportRequestSchema };
