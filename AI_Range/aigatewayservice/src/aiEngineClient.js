"use strict";

/*
  This is the one file you actually need to touch to wire up a real AI
  engine.

  Nothing else in the service (routes.js, eventAdapter.js, server.js) knows
  or cares what your engine is, how it's hosted, or which model it calls.
  They only ever talk to the four functions exported at the bottom of this
  file: recommendIntervention(), assessActionQuality(),
  evaluateResourceNeeds(), and generateAfterActionReport(). Swap the four
  callXxxModel() stub bodies below for real calls into your engine (an SDK
  call, an internal HTTP call, a subprocess, whatever fits your setup) and
  nothing else in the gateway needs to change.

  A few guardrails are baked into this file on purpose:
    - system prompts are fixed and versioned, never exercise-specific
    - output is tool-forced and validated against a JSON schema
    - if validation fails, we retry once with the error appended, then fall
      back to something safe
    - every result gets stamped with whatever prompt/schema version
      produced it, so we can always trace back why the AI suggested
      something
 */

const { validate } = require("./schemas/validator");
const { RECOMMENDATION_TYPES } = require("./schemas/recommendation");
const { QUALITY_DIMENSIONS } = require("./schemas/assessment");
const { RESOURCE_TYPES } = require("./schemas/resourceRequest");
const {
  guidedRecommendationOutputSchema,
  guidedResourceRequestOutputSchema,
  guidedAssessmentOutputSchema,
} = require("./schemas/guided");
const config = require("./config");

// Overridable HTTP layer, so this file (and anything that calls it) is
// exercisable in tests/dev without a live vLLM instance - the same
// "runnable and testable before the real engine is wired in" property the
// old hardcoded stubs gave for free. Production never touches this; it's
// only ever set by test/aiEngineClient.test.js.
let fetchImpl = (...args) => fetch(...args);
function __setFetchImpl(fn) {
  fetchImpl = fn;
}
function __resetFetchImpl() {
  fetchImpl = (...args) => fetch(...args);
}

// Static, versioned system prompts. Bump the version string whenever the
// wording changes. Every recommendation, assessment, and report gets
// stamped with whichever version produced it, so "why did the AI suggest
// this three weeks ago" is always answerable.

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

const CAPACITY_ANALYTICS_SYSTEM_PROMPT_VERSION = "capacity-analytics@1.0.0";
const CAPACITY_ANALYTICS_SYSTEM_PROMPT = `
You are the AI Decision Engine's capacity-analytics mode. You watch exercise
state for signals that the running scenario needs more infrastructure than
it currently has - e.g. a threat-actor simulation about to pivot to a host
that requires its own attacker VM - or that the environment should be
reshaped to keep testing the student (a new network segment, more compute
for a scoring-heavy phase). You never provision anything yourself.

Rules:
- Only reference resource types from the provided valid_resource_types list.
- Respond ONLY through the evaluate_resource_needs tool call. Never respond
  with free text.
- resource_needed: false is the common, often correct answer. Do not request
  a resource just because you were asked to evaluate.
- You decide WHETHER additional infrastructure is warranted and WHY; you
  never decide HOW it gets provisioned - that is entirely owned by the
  control plane's Resource Scheduler. Your output is a request, not a command.
- Always include a short, concrete justification grounded in the snapshot
  data you were given - it is shown to instructors and stored in the audit
  trail alongside the resulting ResourceRequestRaised event.
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

// Per-mode model config. Live adaptation has to be fast (small context, low
// temperature, a small/quick model); reporting and assessment can tolerate
// more latency and benefit from a bigger model doing more reasoning.
//
// Which logical model backs each mode comes from config.modelTiers (env
// var per mode); where that model actually lives (baseUrl, served name)
// comes from config.upstreams (the "active model set is configuration, not
// code" registry - see src/config.js and src/upstreams.js). Resolving both
// here, once, keeps every call site below oblivious to either.
function resolveTier(logicalName, { temperature, timeoutMs }) {
  const upstream = config.upstreams[logicalName];
  if (!upstream) {
    throw new Error(
      `[ai-gateway] aiEngineClient: no upstream configured for model "${logicalName}" - ` +
        `check config.modelTiers / config.upstreams (UPSTREAMS_JSON, AI_MODEL_* env vars).`
    );
  }
  return {
    model: logicalName,
    servedModelName: upstream.servedModelName,
    baseUrl: upstream.baseUrl,
    guidedDecoding: Boolean(upstream.guidedDecoding),
    temperature,
    timeoutMs,
  };
}

const MODEL_TIERS = {
  liveAdaptation: resolveTier(config.modelTiers.liveAdaptation, {
    temperature: 0,
    timeoutMs: config.liveCallTimeoutMs,
  }),
  assessment: resolveTier(config.modelTiers.assessment, {
    temperature: 0.2,
    timeoutMs: config.reportCallTimeoutMs,
  }),
  capacityAnalytics: resolveTier(config.modelTiers.capacityAnalytics, {
    // Fires on the same telemetry cadence as live adaptation, so it gets the
    // same cheap/fast tier and the live-call timeout, not the report one.
    temperature: 0,
    timeoutMs: config.liveCallTimeoutMs,
  }),
  report: resolveTier(config.modelTiers.report, {
    temperature: 0.4,
    timeoutMs: config.reportCallTimeoutMs,
  }),
};

// --- The one place that actually talks to vLLM's OpenAI-compatible API ----
//
// Every callXxxModel() below builds a system/user prompt pair and calls
// this. It POSTs to {baseUrl}/v1/chat/completions, optionally constraining
// the model's output to a JSON Schema via guided decoding
// (response_format), and returns the parsed message content.
//
// Deliberately does NOT catch/convert errors for the report path (the
// caller lets them propagate to routes.js's jobStore.fail()). The three
// structured modes (recommendation/resource/assessment) DO catch here and
// return an object that will fail its ajv check - see the try/catch in
// each callXxxModel below - so a network failure flows through the exact
// same retry-then-fallback path as a malformed model response, and none of
// recommendIntervention/evaluateResourceNeeds/assessActionQuality need to
// know the difference.
async function postChatCompletion({
  baseUrl,
  servedModelName,
  systemPrompt,
  userPrompt,
  temperature,
  timeoutMs,
  maxTokens,
  jsonSchema, // { name, schema } | undefined - omit for free-form (report) output
}) {
  const body = {
    model: servedModelName,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  if (jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true },
    };
  }

  const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vLLM ${baseUrl} returned ${res.status}: ${text.slice(0, 500)}`);
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`vLLM ${baseUrl} returned no message content`);
  }
  return content;
}

async function postStructuredChatCompletion(args) {
  const content = await postChatCompletion(args);
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`vLLM ${args.baseUrl} returned non-JSON content: ${err.message}`);
  }
}

// --- Integration point 1 of 4: live adaptation ----------------------------
//
// Replace the body of callRecommendationModel() with a call into your real
// engine. It just needs to return something matching the
// recommend_intervention tool schema (src/schemas/recommendation.js) - if
// your engine already does tool-forced structured output, you're probably
// just reshaping its response here.
// ---------------------------------------------------------------------------
async function callRecommendationModel({ systemPrompt, userPrompt, tier, priorError }) {
  try {
    return await postStructuredChatCompletion({
      baseUrl: tier.baseUrl,
      servedModelName: tier.servedModelName,
      systemPrompt,
      userPrompt: priorError ? `${userPrompt}\n\nPrevious attempt was invalid: ${priorError}` : userPrompt,
      temperature: tier.temperature,
      timeoutMs: tier.timeoutMs,
      maxTokens: 512,
      jsonSchema: tier.guidedDecoding
        ? { name: "recommend_intervention", schema: guidedRecommendationOutputSchema }
        : undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[aiEngineClient] recommendation call failed:", err.message);
    // Return something that will fail ajv validation, so this flows through
    // the exact same retry-then-no_action-fallback path as a malformed
    // model response - recommendIntervention() doesn't need to know a
    // network error and a bad model response are different things.
    return {};
  }
}

function buildLiveAdaptationPrompt({ snapshot, scenarioConstraints, recentRecommendations }) {
  return JSON.stringify(
    {
      state_snapshot: snapshot,
      scenario_constraints: scenarioConstraints || {},
      // Only send the last few recommendations, not the full exercise
      // history - keeps latency/cost flat no matter how long the exercise
      // runs, and gives the model enough to avoid repeating something
      // already rejected.
      recent_recommendations: (recentRecommendations || []).slice(-5),
      valid_recommendation_types: RECOMMENDATION_TYPES,
    },
    null,
    2
  );
}

/**
 * Given a current exercise state snapshot, decide whether to intervene.
 * Called on state transitions (throttled) by eventAdapter.js, or directly
 * via POST /v1/recommendations.
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

  // Give it one more shot, with the validation error appended so it has a
  // chance to self-correct.
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

  // Don't let a malformed AI response block the exercise - fall back instead.
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

// --- Integration point 2 of 4: capacity analytics (resource requests) -----
//
// Replace the body of callResourceRequestModel() with a call into your real
// engine. It needs to return something matching the evaluate_resource_needs
// tool schema (src/schemas/resourceRequest.js). This is the AI half of the
// "AI never touches infrastructure directly" boundary: the gateway only
// ever turns a resource_needed: true answer into a ResourceRequestRaised
// event (see eventAdapter.js), and leaves the control plane's Resource
// Scheduler to decide what actually happens with it.
// ---------------------------------------------------------------------------
async function callResourceRequestModel({ systemPrompt, userPrompt, tier, priorError }) {
  try {
    return await postStructuredChatCompletion({
      baseUrl: tier.baseUrl,
      servedModelName: tier.servedModelName,
      systemPrompt,
      userPrompt: priorError ? `${userPrompt}\n\nPrevious attempt was invalid: ${priorError}` : userPrompt,
      temperature: tier.temperature,
      timeoutMs: tier.timeoutMs,
      maxTokens: 512,
      jsonSchema: tier.guidedDecoding
        ? { name: "evaluate_resource_needs", schema: guidedResourceRequestOutputSchema }
        : undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[aiEngineClient] resource-request call failed:", err.message);
    // Same reasoning as callRecommendationModel() above - fail validation,
    // let evaluateResourceNeeds() fall back to resource_needed: false.
    return {};
  }
}

function buildResourceRequestPrompt({ snapshot, scenarioConstraints }) {
  return JSON.stringify(
    {
      state_snapshot: snapshot,
      scenario_constraints: scenarioConstraints || {},
      valid_resource_types: RESOURCE_TYPES,
    },
    null,
    2
  );
}

/**
 * Given a current exercise state snapshot, decide whether the scenario
 * needs more infrastructure (or a reshape) than it currently has. Called on
 * state transitions by eventAdapter.js, throttled independently of the
 * live-adaptation check above.
 *
 * @returns {Promise<{resourceRequest: object, promptVersion: string, schemaVersion: string, attempts: number}>}
 */
async function evaluateResourceNeeds({ exerciseId, studentId, snapshot, scenarioConstraints }) {
  const tier = MODEL_TIERS.capacityAnalytics;
  const userPrompt = buildResourceRequestPrompt({ snapshot, scenarioConstraints });

  const attempt1 = await callResourceRequestModel({
    systemPrompt: CAPACITY_ANALYTICS_SYSTEM_PROMPT,
    userPrompt,
    tier,
  });
  const check1 = validate("resource-request-output", attempt1);
  if (check1.valid) {
    return finalizeResourceRequest(attempt1, 1);
  }

  // Same retry-once pattern as the recommendation call above.
  const attempt2 = await callResourceRequestModel({
    systemPrompt: CAPACITY_ANALYTICS_SYSTEM_PROMPT,
    userPrompt,
    tier,
    priorError: check1.errors.join("; "),
  });
  const check2 = validate("resource-request-output", attempt2);
  if (check2.valid) {
    return finalizeResourceRequest(attempt2, 2);
  }

  // Don't raise a resource request off malformed model output - just say no.
  return finalizeResourceRequest(
    { resource_needed: false },
    2,
    { fallback: true, exerciseId, studentId }
  );
}

function finalizeResourceRequest(resourceRequest, attempts, extra = {}) {
  return {
    resourceRequest,
    promptVersion: CAPACITY_ANALYTICS_SYSTEM_PROMPT_VERSION,
    schemaVersion: "resource-request-output@1",
    attempts,
    ...extra,
  };
}

// --- Integration point 3 of 4: qualitative assessment (scoring engine) ----
async function callAssessmentModel({ systemPrompt, userPrompt, tier, priorError }) {
  try {
    return await postStructuredChatCompletion({
      baseUrl: tier.baseUrl,
      servedModelName: tier.servedModelName,
      systemPrompt,
      userPrompt: priorError ? `${userPrompt}\n\nPrevious attempt was invalid: ${priorError}` : userPrompt,
      temperature: tier.temperature,
      timeoutMs: tier.timeoutMs,
      maxTokens: 768,
      jsonSchema: tier.guidedDecoding
        ? { name: "assess_action_quality", schema: guidedAssessmentOutputSchema }
        : undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[aiEngineClient] assessment call failed:", err.message);
    // Same reasoning as callRecommendationModel() above - fail validation,
    // let assessActionQuality() fall back to a withheld assessment.
    return {};
  }
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
 * Grade HOW WELL a student completed an objective that's already been
 * marked complete deterministically elsewhere. Called once per objective on
 * completion (by eventAdapter.js), or directly via POST /v1/assessments.
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

// --- Integration point 4 of 4: after-action report generation -------------
// There's no forced tool schema here since the output is a narrative, not a
// structured decision - but it's still versioned and still auditable via
// the prompt version stamp and the exact history payload that was sent.
// ---------------------------------------------------------------------------
async function callReportModel({ systemPrompt, userPrompt, tier }) {
  // No jsonSchema here - the report is narrative prose, not a structured
  // decision, so it's the one mode that isn't guided-decoded. Errors are
  // intentionally left to propagate (unlike the three modes above): the
  // caller, generateAfterActionReport(), has no retry/fallback of its own,
  // and routes.js already turns a thrown error here into a failed job via
  // jobStore.fail() rather than blocking anything live.
  const narrative = await postChatCompletion({
    baseUrl: tier.baseUrl,
    servedModelName: tier.servedModelName,
    systemPrompt,
    userPrompt,
    temperature: tier.temperature,
    timeoutMs: tier.timeoutMs,
    maxTokens: 4096,
  });
  return { narrative };
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
 * Generate the after-action report. This one's long-running compared to the
 * other modes, so treat it as async - see src/store/jobStore.js and the
 * POST /v1/reports + GET /v1/reports/:job_id pair in routes.js.
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
  evaluateResourceNeeds,
  generateAfterActionReport,
  // only exported for tests / introspection
  LIVE_ADAPTATION_SYSTEM_PROMPT_VERSION,
  ASSESSMENT_SYSTEM_PROMPT_VERSION,
  CAPACITY_ANALYTICS_SYSTEM_PROMPT_VERSION,
  REPORT_SYSTEM_PROMPT_VERSION,
  MODEL_TIERS,
  __setFetchImpl,
  __resetFetchImpl,
};
