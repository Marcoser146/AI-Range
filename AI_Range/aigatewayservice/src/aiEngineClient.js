"use strict";

/**
 * aiEngineClient.js — THE ONE FILE YOU EDIT TO INTEGRATE YOUR AI ENGINE.
 *
 * Nothing else in this service (routes.js, eventAdapter.js, server.js) knows
 * or cares what your engine is, how it's hosted, or which model(s) it calls.
 * They only ever call the three functions exported at the bottom of this
 * file: recommendIntervention(), assessActionQuality(), and
 * generateAfterActionReport(). Swap the three `callXxxModel()` stub bodies
 * below for real calls into your engine (SDK call, internal HTTP call,
 * subprocess, whatever) and the rest of the gateway needs no changes.
 *
 * Everything in this file enforces the guardrails described in the design:
 *   - fixed, versioned system prompts (never exercise-specific rules)
 *   - tool-forced structured output, validated against a JSON schema
 *   - one retry with the validation error appended, then a safe fallback
 *   - prompt/schema version stamped on every result for the audit trail
 */

const { validate } = require("./schemas/validator");
const { RECOMMENDATION_TYPES } = require("./schemas/recommendation");
const { QUALITY_DIMENSIONS } = require("./schemas/assessment");
const config = require("./config");

// ---------------------------------------------------------------------------
// Versioned, static system prompts. Bump the version string any time the
// text changes - every recommendation/assessment/report is stamped with
// whichever version produced it, so "why did the AI suggest this three weeks
// ago" is always answerable.
// ---------------------------------------------------------------------------

const LIVE_ADAPTATION_SYSTEM_PROMPT_VERSION = "live-adaptation@1.0.0";
const LIVE_ADAPTATION_SYSTEM_PROMPT = `
You are the AI Decision Engine for a cyber range training platform.
Your job is to recommend interventions when a student appears stuck or a
scenario needs to adapt - you never narrate directly to students and you
never alter scoring yourself.

Rules:
- Only reference injects, branches, and objectives that are explicitly
  present in the provided scenario graph. Never invent content.
- Respond ONLY through the recommend_intervention tool call. Never respond
  with free text.
- "no_action" is a valid, often correct, recommendation. Do not recommend
  an intervention just because you were asked to evaluate the state.
- Always include a short, concrete rationale grounded in the snapshot data
  you were given - this rationale is shown to instructors and stored in the
  after-action report.
`.trim();

const ASSESSMENT_SYSTEM_PROMPT_VERSION = "assessment@1.0.0";
const ASSESSMENT_SYSTEM_PROMPT = `
You are the AI Decision Engine's qualitative assessment mode. You evaluate
HOW WELL a student performed a completed objective (methodology, efficiency,
or documentation quality) - not WHETHER they completed it, which is already
determined deterministically upstream.

Rules:
- quality_score is a signal between 0 and 1, not a point value. You do not
  decide how much this signal is worth relative to objective completion -
  that is fixed in the exercise's authored rubric outside your control.
- Respond ONLY through the assess_action_quality tool call.
- evidence must cite specific actions/timestamps/text from the provided
  action log, not general impressions.
- Always include a rationale a human grader could audit and disagree with.
`.trim();

const REPORT_SYSTEM_PROMPT_VERSION = "after-action-report@1.0.0";
const REPORT_SYSTEM_PROMPT = `
You are the AI Decision Engine in after-action report mode. You are given
the full history of an exercise - state snapshots over time, every
recommendation that was generated and whether it was applied or rejected,
qualitative assessments, and final scores. Synthesize a narrative summary
suitable for an instructor and, in redacted form, a student.

Rules:
- Base every claim on the provided history. Do not speculate about student
  intent beyond what the telemetry and recommendation log support.
- Call out any rejected AI recommendations and, where evident, why an
  instructor may have rejected them - this is part of what makes the
  process auditable.
- Keep the narrative organized by objective, then by overall exercise flow.
`.trim();

// ---------------------------------------------------------------------------
// Model tier / call-shape config per mode. Live adaptation is optimized for
// latency (small context, low temperature, small/fast model); reporting and
// assessment tolerate more latency and benefit from a larger model.
// ---------------------------------------------------------------------------

const MODEL_TIERS = {
  liveAdaptation: {
    // e.g. a fast/small model - tune to your latency budget.
    model: process.env.AI_MODEL_LIVE || "fast-tier",
    temperature: 0,
    timeoutMs: config.liveCallTimeoutMs,
  },
  assessment: {
    model: process.env.AI_MODEL_ASSESSMENT || "reasoning-tier",
    temperature: 0.2,
    timeoutMs: config.reportCallTimeoutMs,
  },
  report: {
    // e.g. a larger/deeper-reasoning model - runs once, at exercise end.
    model: process.env.AI_MODEL_REPORT || "reasoning-tier",
    temperature: 0.4,
    timeoutMs: config.reportCallTimeoutMs,
  },
};

// ---------------------------------------------------------------------------
// INTEGRATION POINT 1 of 3: live adaptation.
//
// Replace the body of callRecommendationModel() with a call into your real
// engine. It must return an object matching the recommend_intervention tool
// schema (src/schemas/recommendation.js) - if your engine already does
// tool-forced structured output, just adapt its response shape here.
// ---------------------------------------------------------------------------
async function callRecommendationModel({ systemPrompt, userPrompt, tier, priorError }) {
  // ---- STUB (replace me) -------------------------------------------------
  // A real implementation calls your engine, e.g.:
  //
  //   const result = await myEngine.run({
  //     system: systemPrompt,
  //     input: userPrompt,
  //     model: tier.model,
  //     temperature: tier.temperature,
  //     timeoutMs: tier.timeoutMs,
  //     tool: RECOMMEND_INTERVENTION_TOOL_SCHEMA,
  //     retryContext: priorError,
  //   });
  //   return result.toolCall.input;
  //
  // The deterministic stub below exists only so this service is runnable
  // and testable before you've wired in the real engine.
  void systemPrompt;
  void userPrompt;
  void tier;
  void priorError;
  return {
    recommendation_type: "no_action",
    confidence: 0.5,
    rationale: "Stub engine: no live model wired in yet (see aiEngineClient.js).",
  };
  // ---- END STUB ------------------------------------------------------------
}

function buildLiveAdaptationPrompt({ snapshot, scenarioConstraints, recentRecommendations }) {
  return JSON.stringify(
    {
      state_snapshot: snapshot,
      scenario_constraints: scenarioConstraints || {},
      // Only the last few recommendations, not full exercise history - this
      // keeps latency/cost flat regardless of exercise length, and lets the
      // model avoid repeating something already rejected.
      recent_recommendations: (recentRecommendations || []).slice(-5),
      valid_recommendation_types: RECOMMENDATION_TYPES,
    },
    null,
    2
  );
}

/**
 * Live-adaptation call: given a current exercise state snapshot, decide
 * whether to intervene. Called on state transitions / throttled interval by
 * eventAdapter.js, or synchronously via POST /v1/recommendations.
 *
 * @returns {Promise<{recommendation: object, promptVersion: string, schemaVersion: string, attempts: number}>}
 */
async function recommendIntervention({
  exerciseId,
  studentId,
  snapshot,
  scenarioConstraints,
  recentRecommendations,
}) {
  const tier = MODEL_TIERS.liveAdaptation;
  const userPrompt = buildLiveAdaptationPrompt({
    snapshot,
    scenarioConstraints,
    recentRecommendations,
  });

  const attempt1 = await callRecommendationModel({
    systemPrompt: LIVE_ADAPTATION_SYSTEM_PROMPT,
    userPrompt,
    tier,
  });
  const check1 = validate("recommendation-output", attempt1);
  if (check1.valid) {
    return finalizeRecommendation(attempt1, 1);
  }

  // One retry, with the validation error appended so the model can self-correct.
  const attempt2 = await callRecommendationModel({
    systemPrompt: LIVE_ADAPTATION_SYSTEM_PROMPT,
    userPrompt,
    tier,
    priorError: check1.errors.join("; "),
  });
  const check2 = validate("recommendation-output", attempt2);
  if (check2.valid) {
    return finalizeRecommendation(attempt2, 2);
  }

  // Fallback: never block the exercise on a malformed AI response.
  return finalizeRecommendation(
    {
      recommendation_type: "no_action",
      confidence: 0,
      rationale: `Fell back to no_action after invalid model output: ${check2.errors.join("; ")}`,
    },
    2,
    { fallback: true, exerciseId, studentId }
  );
}

function finalizeRecommendation(recommendation, attempts, extra = {}) {
  return {
    recommendation,
    promptVersion: LIVE_ADAPTATION_SYSTEM_PROMPT_VERSION,
    schemaVersion: "recommendation-output@1",
    attempts,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// INTEGRATION POINT 2 of 3: qualitative assessment (scoring engine).
// ---------------------------------------------------------------------------
async function callAssessmentModel({ systemPrompt, userPrompt, tier, priorError }) {
  // ---- STUB (replace me) -- see callRecommendationModel() for the shape. --
  void systemPrompt;
  void userPrompt;
  void tier;
  void priorError;
  return {
    objective_id: "unknown",
    quality_score: 0.5,
    dimension: "methodology",
    evidence: "",
    rationale: "Stub engine: no live model wired in yet (see aiEngineClient.js).",
  };
  // ---- END STUB ------------------------------------------------------------
}

function buildAssessmentPrompt({ objectiveId, dimension, actionLog, submissionText }) {
  return JSON.stringify(
    {
      objective_id: objectiveId,
      dimension: dimension || undefined,
      valid_dimensions: QUALITY_DIMENSIONS,
      action_log: actionLog,
      submission_text: submissionText || undefined,
    },
    null,
    2
  );
}

/**
 * Qualitative assessment call: grade HOW WELL a student completed an
 * objective that has already been marked complete deterministically.
 * Called once per objective on completion (by eventAdapter.js) or
 * synchronously via POST /v1/assessments.
 */
async function assessActionQuality({
  exerciseId,
  studentId,
  objectiveId,
  dimension,
  actionLog,
  submissionText,
}) {
  const tier = MODEL_TIERS.assessment;
  const userPrompt = buildAssessmentPrompt({ objectiveId, dimension, actionLog, submissionText });

  const attempt1 = await callAssessmentModel({
    systemPrompt: ASSESSMENT_SYSTEM_PROMPT,
    userPrompt,
    tier,
  });
  const check1 = validate("assessment-output", attempt1);
  if (check1.valid) return finalizeAssessment(attempt1, 1);

  const attempt2 = await callAssessmentModel({
    systemPrompt: ASSESSMENT_SYSTEM_PROMPT,
    userPrompt,
    tier,
    priorError: check1.errors.join("; "),
  });
  const check2 = validate("assessment-output", attempt2);
  if (check2.valid) return finalizeAssessment(attempt2, 2);

  return finalizeAssessment(
    {
      objective_id: objectiveId,
      quality_score: 0,
      dimension: dimension || "methodology",
      evidence: "",
      rationale: `Assessment withheld after invalid model output: ${check2.errors.join("; ")}`,
    },
    2,
    { fallback: true, exerciseId, studentId }
  );
}

function finalizeAssessment(assessment, attempts, extra = {}) {
  return {
    assessment,
    promptVersion: ASSESSMENT_SYSTEM_PROMPT_VERSION,
    schemaVersion: "assessment-output@1",
    attempts,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// INTEGRATION POINT 3 of 3: after-action report generation (EP4).
// No forced tool schema here - the output is a narrative, not a structured
// decision - but it is still versioned and still auditable via the prompt
// version stamp and the exact history payload that was sent.
// ---------------------------------------------------------------------------
async function callReportModel({ systemPrompt, userPrompt, tier }) {
  // ---- STUB (replace me) ----------------------------------------------
  void tier;
  return {
    narrative:
      "Stub engine: no live model wired in yet (see aiEngineClient.js). " +
      `Would summarize exercise history (${userPrompt.length} chars of context) ` +
      `using system prompt "${systemPrompt.slice(0, 40)}...".`,
  };
  // ---- END STUB ------------------------------------------------------------
}

function buildReportPrompt({ exerciseId, stateSnapshots, recommendations, assessments, finalScores }) {
  return JSON.stringify(
    {
      exercise_id: exerciseId,
      state_snapshots: stateSnapshots || [],
      recommendations: recommendations || [],
      assessments: assessments || [],
      final_scores: finalScores || {},
    },
    null,
    2
  );
}

/**
 * After-action report call. Long-running relative to the other two modes -
 * callers should treat this as async (see src/store/jobStore.js and the
 * POST /v1/reports + GET /v1/reports/:job_id pair in routes.js).
 */
async function generateAfterActionReport({
  exerciseId,
  stateSnapshots,
  recommendations,
  assessments,
  finalScores,
}) {
  const tier = MODEL_TIERS.report;
  const userPrompt = buildReportPrompt({
    exerciseId,
    stateSnapshots,
    recommendations,
    assessments,
    finalScores,
  });

  const result = await callReportModel({
    systemPrompt: REPORT_SYSTEM_PROMPT,
    userPrompt,
    tier,
  });

  return {
    narrative: result.narrative,
    promptVersion: REPORT_SYSTEM_PROMPT_VERSION,
    schemaVersion: "report-narrative@1",
  };
}

module.exports = {
  recommendIntervention,
  assessActionQuality,
  generateAfterActionReport,
  // exported for tests / introspection only
  LIVE_ADAPTATION_SYSTEM_PROMPT_VERSION,
  ASSESSMENT_SYSTEM_PROMPT_VERSION,
  REPORT_SYSTEM_PROMPT_VERSION,
};
