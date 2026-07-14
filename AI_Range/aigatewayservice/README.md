# AI-Range

## AI Gateway Service

This repo contains the **AI Gateway Service** — the thin wrapper that
integrates an already-built AI decision engine into the AI-Range event
plane. It exposes the engine's four modes (live-adaptation recommendations,
qualitative assessments, capacity/infrastructure requests, after-action
reporting) through:

- a REST API, for on-demand/synchronous calls (instructor dashboard, EP4
  report kickoff, integration tests), and
- an event-bus adapter, for the automated live-adaptation loop the timeline
  engine and scoring engine consume.

Both paths funnel through a single file — `src/aiEngineClient.js` — which
is the only place that needs to change to plug in a real engine.

### Layout

```
src/
  aiEngineClient.js   # THE integration point — replace the 4 model call stubs
  eventAdapter.js      # subscribes to StateSnapshotUpdated/ObjectiveCompleted,
                        # publishes AIRecommendationGenerated/AIAssessmentGenerated/
                        # ResourceRequestRaised
  routes.js             # REST endpoints (Express router)
  server.js             # wires broker + event adapter + HTTP server
  config.js             # env-driven config
  brokers/
    inMemoryBroker.js   # dev/test pub-sub; swap for Kafka/RabbitMQ/NATS
  middleware/
    auth.js              # bearer-token check
    errorHandler.js       # uniform { error: { code, message } } shape
    idempotency.js        # Idempotency-Key replay cache
  schemas/
    recommendation.js, assessment.js, resourceRequest.js, report.js, validator.js
    # ajv schemas the model's tool-forced output (and REST request bodies)
    # are validated against
  store/
    jobStore.js          # in-memory job store for the async report path
openapi/
  ai-gateway.yaml        # full REST API spec
test/
  *.test.js              # node:test suite (event adapter, engine client,
                          # schema validation, REST routes)
frontend/
  src/
    api/                  # fetch client + hand-written types mirroring the OpenAPI spec
    components/           # HealthBanner, RecommendationForm, AssessmentForm, ReportPanel
    App.tsx                # instructor dashboard exercising the REST endpoints below
```

### Integrating your AI engine

Open `src/aiEngineClient.js` and replace the four `callXxxModel()` stub
bodies (`callRecommendationModel`, `callAssessmentModel`,
`callResourceRequestModel`, `callReportModel`) with real calls into your
engine. Nothing else in the service needs to change — `eventAdapter.js`,
`routes.js`, and `server.js` only ever call the four exported functions
(`recommendIntervention`, `assessActionQuality`, `evaluateResourceNeeds`,
`generateAfterActionReport`).

Each mode has:
- a fixed, versioned system prompt (bump the version string if you edit it),
- a JSON-schema-validated structured output (`src/schemas/`), with one retry
  on validation failure and a safe fallback (`no_action` / withheld
  assessment) rather than blocking the exercise, and
- a distinct model tier / latency budget (`MODEL_TIERS` in
  `aiEngineClient.js`) — live adaptation is tuned for low latency, report
  generation is not.

### Running it

```bash
npm install
cp .env.example .env   # set a real AI_GATEWAY_API_KEY
npm start               # or: npm run dev (auto-restart)
npm test                # node:test suite
```

### Frontend (instructor dashboard)

A small Vite + React + TypeScript app in `frontend/` exercises all four REST
endpoints: a live health banner, a form to request live-adaptation
recommendations, a form to request qualitative assessments, and a panel to
kick off and poll after-action reports.

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173, proxies /v1 -> http://localhost:8080
```

Run the gateway itself (`npm start` from the repo root) alongside it. On
first load, open the settings bar and paste the gateway's
`AI_GATEWAY_API_KEY` — it's kept in `localStorage`, never baked into the
build, since a static bundle is public.

### REST API

See `openapi/ai-gateway.yaml` for the full spec. Summary:

| Method & path              | Purpose                              | Response pattern                          |
|-----------------------------|---------------------------------------|--------------------------------------------|
| `GET /v1/health`            | Liveness check                        | `200`, no auth                              |
| `POST /v1/recommendations`  | Live-adaptation call                  | `200` sync, supports `Idempotency-Key`      |
| `POST /v1/assessments`      | Qualitative scoring, one objective    | `200` sync                                  |
| `POST /v1/reports`          | Start an after-action report (EP4)    | `202` + `job_id`, async                     |
| `GET /v1/reports/:job_id`   | Poll report status                    | `200` with `pending`/`complete`/`failed`    |

All protected routes require `Authorization: Bearer <AI_GATEWAY_API_KEY>`.
Every error response has the shape `{ "error": { "code", "message" } }`.

### Event-bus integration

`src/eventAdapter.js` subscribes to `StateSnapshotUpdated` and
`ObjectiveCompleted` on the broker and publishes `AIRecommendationGenerated`
/ `AIAssessmentGenerated` / `ResourceRequestRaised`. It also implements the
approval-gate policy: `no_action` and high-confidence, non-structural
recommendations auto-apply; `branch_change`/`extend_time` and low-confidence
recommendations are routed `pending_approval` for an instructor.
`src/brokers/inMemoryBroker.js` is dev/test only — point `server.js` at your
real broker client and `eventAdapter.js` does not need to change, since it
only depends on the `{ subscribe, publish }` interface.

#### Capacity/infrastructure requests (`ResourceRequestRaised`)

Not every AI decision is about the scenario — some are about capacity. On
every `StateSnapshotUpdated`, independently of (and on the same throttle
cadence as) the live-adaptation recommendation check, the gateway also asks
the engine's capacity-analytics mode (`evaluateResourceNeeds` in
`aiEngineClient.js`) whether the exercise needs more infrastructure than it
currently has — e.g. an extra attacker VM to simulate a pivot — or should be
reshaped to keep testing the student. If so, it publishes:

```json
{
  "event": "ResourceRequestRaised",
  "exercise_id": "ex-4471",
  "requested_by": "ai_decision_engine",
  "resource": "attacker-vm",
  "justification": "Simulating pivot from DC01"
}
```

The gateway never provisions anything itself — this event is only ever a
request. The control plane's Resource Scheduler owns provisioning and
decides whether/how to act on it. That boundary (AI reasons about what's
needed and why, control plane is the only thing that can spin up
infrastructure) is what keeps this safe to scale: an AI system reasoning
about attacker behavior never gets direct infrastructure access.
