"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createEventAdapter, TOPICS } = require("../src/eventAdapter");
const { InMemoryBroker } = require("../src/brokers/inMemoryBroker");

function fakeEngine(overrides = {}) {
  return {
    recommendIntervention: async () => ({
      recommendation: {
        recommendation_type: "inject_hint",
        target_id: "hint-lateral-movement-01",
        confidence: 0.82,
        rationale: "Student blocked 12min on obj-2, no lateral movement attempted",
      },
      promptVersion: "live-adaptation@1.0.0",
      schemaVersion: "recommendation-output@1",
      attempts: 1,
    }),
    assessActionQuality: async () => ({
      assessment: {
        objective_id: "obj-2",
        quality_score: 0.7,
        dimension: "methodology",
        evidence: "used nmap then metasploit in a coherent sequence",
        rationale: "Clear systematic approach with minimal trial-and-error",
      },
      promptVersion: "assessment@1.0.0",
      schemaVersion: "assessment-output@1",
      attempts: 1,
    }),
    ...overrides,
  };
}

test("StateSnapshotUpdated with a blocked objective produces AIRecommendationGenerated", async () => {
  const broker = new InMemoryBroker();
  const adapter = createEventAdapter({ broker, engine: fakeEngine() });
  adapter.start();

  const received = [];
  broker.subscribe(TOPICS.AI_RECOMMENDATION_GENERATED, (event) => received.push(event));

  await broker.publish(TOPICS.STATE_SNAPSHOT_UPDATED, {
    snapshot: {
      exercise_id: "ex-4471",
      elapsed_minutes: 47,
      objectives: [
        { id: "obj-1", status: "complete" },
        { id: "obj-2", status: "in_progress", blocked_minutes: 12 },
      ],
    },
    student_id: "s-118",
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].recommendation_type, "inject_hint");
  assert.equal(received[0].approval_status, "auto_apply");
  assert.equal(received[0].exercise_id, "ex-4471");
});

test("StateSnapshotUpdated with no blocked objective does not call the engine", async () => {
  const broker = new InMemoryBroker();
  let calls = 0;
  const engine = fakeEngine({
    recommendIntervention: async () => {
      calls += 1;
      throw new Error("should not be called");
    },
  });
  const adapter = createEventAdapter({ broker, engine });
  adapter.start();

  await broker.publish(TOPICS.STATE_SNAPSHOT_UPDATED, {
    snapshot: {
      exercise_id: "ex-4471",
      objectives: [{ id: "obj-1", status: "in_progress", blocked_minutes: 2 }],
    },
  });

  assert.equal(calls, 0);
});

test("low-confidence recommendation is routed to pending_approval", async () => {
  const broker = new InMemoryBroker();
  const engine = fakeEngine({
    recommendIntervention: async () => ({
      recommendation: {
        recommendation_type: "difficulty_adjust",
        target_id: "difficulty-down-1",
        confidence: 0.4,
        rationale: "low signal",
      },
      promptVersion: "v1",
      schemaVersion: "v1",
      attempts: 1,
    }),
  });
  const adapter = createEventAdapter({ broker, engine, autoApplyConfidenceThreshold: 0.8 });
  adapter.start();

  const received = [];
  broker.subscribe(TOPICS.AI_RECOMMENDATION_GENERATED, (event) => received.push(event));

  await broker.publish(TOPICS.STATE_SNAPSHOT_UPDATED, {
    snapshot: {
      exercise_id: "ex-1",
      objectives: [{ id: "obj-1", status: "in_progress", blocked_minutes: 15 }],
    },
  });

  assert.equal(received[0].approval_status, "pending_approval");
});

test("branch_change always requires approval regardless of confidence", async () => {
  const broker = new InMemoryBroker();
  const engine = fakeEngine({
    recommendIntervention: async () => ({
      recommendation: {
        recommendation_type: "branch_change",
        target_id: "branch-new-threat-actor",
        confidence: 0.99,
        rationale: "high confidence but structurally significant",
      },
      promptVersion: "v1",
      schemaVersion: "v1",
      attempts: 1,
    }),
  });
  const adapter = createEventAdapter({ broker, engine, autoApplyConfidenceThreshold: 0.8 });
  adapter.start();

  const received = [];
  broker.subscribe(TOPICS.AI_RECOMMENDATION_GENERATED, (event) => received.push(event));

  await broker.publish(TOPICS.STATE_SNAPSHOT_UPDATED, {
    snapshot: {
      exercise_id: "ex-1",
      objectives: [{ id: "obj-1", status: "in_progress", blocked_minutes: 20 }],
    },
  });

  assert.equal(received[0].approval_status, "pending_approval");
});

test("recommendation with unknown target_id is dropped, not published", async () => {
  const broker = new InMemoryBroker();
  const engine = fakeEngine({
    recommendIntervention: async () => ({
      recommendation: {
        recommendation_type: "inject_hint",
        target_id: "hint-does-not-exist",
        confidence: 0.9,
        rationale: "bogus target",
      },
      promptVersion: "v1",
      schemaVersion: "v1",
      attempts: 1,
    }),
  });
  const adapter = createEventAdapter({ broker, engine });
  adapter.start();

  const received = [];
  broker.subscribe(TOPICS.AI_RECOMMENDATION_GENERATED, (event) => received.push(event));

  await broker.publish(TOPICS.STATE_SNAPSHOT_UPDATED, {
    snapshot: {
      exercise_id: "ex-1",
      objectives: [{ id: "obj-1", status: "in_progress", blocked_minutes: 20 }],
    },
    scenario_constraints: { known_ids: ["hint-a", "hint-b"] },
  });

  assert.equal(received.length, 0);
});

test("ObjectiveCompleted produces AIAssessmentGenerated", async () => {
  const broker = new InMemoryBroker();
  const adapter = createEventAdapter({ broker, engine: fakeEngine() });
  adapter.start();

  const received = [];
  broker.subscribe(TOPICS.AI_ASSESSMENT_GENERATED, (event) => received.push(event));

  await broker.publish(TOPICS.OBJECTIVE_COMPLETED, {
    exercise_id: "ex-4471",
    student_id: "s-118",
    objective_id: "obj-2",
    action_log: [{ command: "nmap -sV DC01", timestamp: "2026-07-10T14:30:00Z" }],
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].objective_id, "obj-2");
  assert.equal(received[0].quality_score, 0.7);
});
