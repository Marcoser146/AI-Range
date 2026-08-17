"use strict";

/**
 * eventAdapter.js - the automated half of the AI Gateway.
 *
 * Subscribes to event-plane topics the State Manager and scoring engine
 * already publish, calls the AI engine (via aiEngineClient.js) the same way
 * the REST layer does, and republishes structured, validated events. This
 * is what makes the live-adaptation loop "automatic" - nothing else has to
 * call the AI engine directly.
 *
 * Topics consumed:
 *   - StateSnapshotUpdated   (from the State Manager)
 *   - ObjectiveCompleted     (from the scoring engine / State Manager)
 *
 * Topics published:
 *   - AIRecommendationGenerated
 *   - AIAssessmentGenerated
 *   - ResourceRequestRaised  (capacity/infrastructure asks, see below)
 *
 * ResourceRequestRaised is the AI-decision-engine -> control-plane path: the
 * analytics side of the engine may decide mid-exercise that the scenario
 * needs more infrastructure (say, an extra attacker VM to simulate a pivot)
 * or should be reshaped to keep testing the student. The gateway never
 * provisions anything itself - it only publishes a request event for the
 * control plane's Resource Scheduler to pick up and act on. That split (AI
 * reasons about what's needed, control plane owns the only thing that can
 * actually spin up infrastructure) is what keeps a system reasoning about
 * attacker behavior from ever getting direct infra access.
 */

const aiEngineClient = require("./aiEngineClient");
const { validate } = require("./schemas/validator");

const TOPICS = {
  STATE_SNAPSHOT_UPDATED: "StateSnapshotUpdated",
  OBJECTIVE_COMPLETED: "ObjectiveCompleted",
  AI_RECOMMENDATION_GENERATED: "AIRecommendationGenerated",
  AI_ASSESSMENT_GENERATED: "AIAssessmentGenerated",
  RESOURCE_REQUEST_RAISED: "ResourceRequestRaised",
};

// Live adaptation isn't called on every telemetry event - only on state
// transitions that look like a stuck-student signal, and never more than
// once per MIN_EVAL_INTERVAL_MS per exercise. Keeps inference cost/latency
// bounded no matter how much telemetry is flowing.
const BLOCKED_MINUTES_TRIGGER = 10;
const MIN_EVAL_INTERVAL_MS = 60_000;

// Capacity analytics doesn't have a cheap pre-filter the way "blocked
// minutes" works for recommendations - whether infrastructure is needed is
// exactly the judgment call we're delegating to the model - so it's
// throttled on time alone, on the same interval, but tracked in its own map
// so it fires independently of the recommendation throttle.
const MIN_CAPACITY_EVAL_INTERVAL_MS = 60_000;

function createEventAdapter({
  broker,
  engine = aiEngineClient,
  autoApplyConfidenceThreshold = 0.8,
  // Anything that changes scoring, ends the exercise early, or adds a new
  // threat-actor branch always goes to the instructor's approval queue, no
  // matter the confidence. This list is a hard floor under the
  // confidence-threshold config below, not a replacement for it.
  alwaysRequiresApprovalTypes = ["branch_change", "extend_time"],
  // Optional: src/store/approvalStore.js. When provided, every
  // pending_approval recommendation is persisted here too, not just
  // published on the broker - this is what src/routes/admin.js reads/
  // writes for the instructor approve/reject workflow. Left undefined by
  // default (a no-op) so existing callers/tests that construct the adapter
  // without one keep working unchanged.
  approvalStore = null,
} = {}) {
  const lastEvalAtByExercise = new Map();
  const lastCapacityEvalAtByExercise = new Map();

  function shouldEvaluate(snapshot) {
    const blockedObjective = (snapshot.objectives || []).find(
      (o) => (o.blocked_minutes || 0) >= BLOCKED_MINUTES_TRIGGER
    );
    if (!blockedObjective) return false;

    const lastEvalAt = lastEvalAtByExercise.get(snapshot.exercise_id) || 0;
    if (Date.now() - lastEvalAt < MIN_EVAL_INTERVAL_MS) return false;

    return true;
  }

  function shouldEvaluateResourceNeeds(snapshot) {
    if (!snapshot.exercise_id) return false;

    const lastEvalAt = lastCapacityEvalAtByExercise.get(snapshot.exercise_id) || 0;
    if (Date.now() - lastEvalAt < MIN_CAPACITY_EVAL_INTERVAL_MS) return false;

    return true;
  }

  // This duplicates a check the timeline engine will also do downstream,
  // but catching a bad target_id here means it never becomes an event on
  // the broker in the first place - keeps the audit log clean even with
  // the redundancy.
  function targetExistsInScenario(targetId, scenarioConstraints) {
    if (!targetId) return true; // no_action carries no target_id
    const knownIds = scenarioConstraints?.known_ids;
    if (!Array.isArray(knownIds)) return true; // nothing to validate against
    return knownIds.includes(targetId);
  }

  function decideApproval(recommendation) {
    if (recommendation.recommendation_type === "no_action") {
      return { status: "auto_apply", reason: "no_action requires no gate" };
    }
    if (alwaysRequiresApprovalTypes.includes(recommendation.recommendation_type)) {
      return { status: "pending_approval", reason: "type always requires instructor approval" };
    }
    if (recommendation.confidence >= autoApplyConfidenceThreshold) {
      return { status: "auto_apply", reason: "confidence at/above auto-apply threshold" };
    }
    return { status: "pending_approval", reason: "confidence below auto-apply threshold" };
  }

  async function maybeEvaluateRecommendation(snapshot, event) {
    if (!shouldEvaluate(snapshot)) return;

    lastEvalAtByExercise.set(snapshot.exercise_id, Date.now());

    const result = await engine.recommendIntervention({
      exerciseId: snapshot.exercise_id,
      studentId: event.student_id,
      snapshot,
      scenarioConstraints: event.scenario_constraints,
      recentRecommendations: event.recent_recommendations,
    });

    const { recommendation } = result;

    if (!targetExistsInScenario(recommendation.target_id, event.scenario_constraints)) {
      // eslint-disable-next-line no-console
      console.error(
        `[eventAdapter] dropping recommendation with unknown target_id "${recommendation.target_id}" ` +
          `for exercise ${snapshot.exercise_id}`
      );
      return;
    }

    const approval = decideApproval(recommendation);

    await broker.publish(TOPICS.AI_RECOMMENDATION_GENERATED, {
      event: TOPICS.AI_RECOMMENDATION_GENERATED,
      exercise_id: snapshot.exercise_id,
      student_id: event.student_id,
      recommendation_type: recommendation.recommendation_type,
      confidence: recommendation.confidence,
      payload: recommendation.target_id ? { target_id: recommendation.target_id } : {},
      rationale: recommendation.rationale,
      approval_status: approval.status,
      approval_reason: approval.reason,
      prompt_version: result.promptVersion,
      schema_version: result.schemaVersion,
      generated_at: new Date().toISOString(),
    });

    if (approvalStore && approval.status === "pending_approval") {
      try {
        await approvalStore.create({
          exercise_id: snapshot.exercise_id,
          student_id: event.student_id,
          recommendation_type: recommendation.recommendation_type,
          target_id: recommendation.target_id || null,
          confidence: recommendation.confidence,
          rationale: recommendation.rationale,
          reason: approval.reason,
          prompt_version: result.promptVersion,
        });
      } catch (err) {
        // A persistence failure here shouldn't unpublish an event that
        // already went out on the broker - log and move on, same as the
        // rest of this file's error handling.
        // eslint-disable-next-line no-console
        console.error("[eventAdapter] failed to persist approval queue entry:", err.message);
      }
    }
  }

  // Capacity/infrastructure side of the same telemetry signal, but it runs
  // independently of maybeEvaluateRecommendation above - a scenario can
  // need more infrastructure whether or not a student happens to be stuck
  // right now. This only ever publishes a request; the control plane's
  // Resource Scheduler is what actually turns ResourceRequestRaised into a
  // VM/segment/capacity change.
  async function maybeEvaluateResourceNeeds(snapshot, event) {
    if (!shouldEvaluateResourceNeeds(snapshot)) return;

    lastCapacityEvalAtByExercise.set(snapshot.exercise_id, Date.now());

    const result = await engine.evaluateResourceNeeds({
      exerciseId: snapshot.exercise_id,
      studentId: event.student_id,
      snapshot,
      scenarioConstraints: event.scenario_constraints,
    });

    const { resourceRequest } = result;
    if (!resourceRequest.resource_needed) return;

    await broker.publish(TOPICS.RESOURCE_REQUEST_RAISED, {
      event: TOPICS.RESOURCE_REQUEST_RAISED,
      exercise_id: snapshot.exercise_id,
      requested_by: "ai_decision_engine",
      resource: resourceRequest.resource,
      justification: resourceRequest.justification,
      prompt_version: result.promptVersion,
      schema_version: result.schemaVersion,
      raised_at: new Date().toISOString(),
    });
  }

  async function handleStateSnapshotUpdated(event) {
    const snapshot = event.snapshot || event;
    await Promise.all([
      maybeEvaluateRecommendation(snapshot, event),
      maybeEvaluateResourceNeeds(snapshot, event),
    ]);
  }

  async function handleObjectiveCompleted(event) {
    const result = await engine.assessActionQuality({
      exerciseId: event.exercise_id,
      studentId: event.student_id,
      objectiveId: event.objective_id,
      dimension: event.dimension,
      actionLog: event.action_log || [],
      submissionText: event.submission_text,
    });

    const check = validate("assessment-output", result.assessment);
    if (!check.valid) {
      // Shouldn't be reachable - aiEngineClient already validates and falls
      // back on its own - but we still don't want a malformed event
      // reaching the broker, so double-check here too.
      // eslint-disable-next-line no-console
      console.error("[eventAdapter] refusing to publish invalid assessment:", check.errors);
      return;
    }

    await broker.publish(TOPICS.AI_ASSESSMENT_GENERATED, {
      event: TOPICS.AI_ASSESSMENT_GENERATED,
      exercise_id: event.exercise_id,
      student_id: event.student_id,
      ...result.assessment,
      prompt_version: result.promptVersion,
      schema_version: result.schemaVersion,
      generated_at: new Date().toISOString(),
    });
  }

  function start() {
    const unsubscribers = [
      broker.subscribe(TOPICS.STATE_SNAPSHOT_UPDATED, handleStateSnapshotUpdated),
      broker.subscribe(TOPICS.OBJECTIVE_COMPLETED, handleObjectiveCompleted),
    ];
    return () => unsubscribers.forEach((unsub) => unsub && unsub());
  }

  return {
    start,
    // exposed so tests can call these directly without going through the broker
    handleStateSnapshotUpdated,
    handleObjectiveCompleted,
    shouldEvaluate,
    shouldEvaluateResourceNeeds,
    decideApproval,
    targetExistsInScenario,
  };
}

module.exports = { createEventAdapter, TOPICS };
