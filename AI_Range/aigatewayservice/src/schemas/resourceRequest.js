"use strict";

// Mirrors the `evaluate_resource_needs` tool schema the AI decision engine's
// capacity-analytics mode is forced to respond through. This is the "AI only
// ever asks" contract: the model may describe what infrastructure it thinks
// the exercise needs and why, but the output has no field that could be
// mistaken for a provisioning instruction — the control plane's Resource
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
  // resource/justification are only required when resource_needed is true —
  // "no, capacity is fine" is the common, cheap-to-validate answer.
  if: {
    properties: { resource_needed: { const: true } },
  },
  then: { required: ["resource", "justification"] },
  else: {},
};

module.exports = { RESOURCE_TYPES, resourceRequestOutputSchema };
