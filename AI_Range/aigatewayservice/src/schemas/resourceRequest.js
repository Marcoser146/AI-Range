"use strict";

// Mirrors the `evaluate_resource_needs` tool schema the AI decision engine's
// capacity-analytics mode is forced to respond through. This is the "AI
// only ever asks" contract: the model can describe what infrastructure it
// thinks the exercise needs and why, but there's no field here that could
// be mistaken for a provisioning instruction. The control plane's Resource
// Scheduler is the only thing that ever acts on it.
const RESOURCE_TYPES = ["attacker-vm", "target-vm", "network-segment", "compute-capacity"];

const resourceRequestOutputSchema = {
  $id: "resource-request-output",
  type: "object",
  additionalProperties: false,
  properties: {
    resource_needed: { type: "boolean" },
    resource: { enum: RESOURCE_TYPES },
    justification: { type: "string", minLength: 1 },
  },
  required: ["resource_needed"],
  // resource/justification are only required when resource_needed is true,
  // and must be absent when it's false - "no, capacity is fine" shouldn't
  // come back with a half-filled-in resource request attached.
  if: {
    properties: { resource_needed: { const: true } },
  },
  then: { required: ["resource", "justification"] },
  else: { not: { anyOf: [{ required: ["resource"] }, { required: ["justification"] }] } },
};

module.exports = { RESOURCE_TYPES, resourceRequestOutputSchema };
