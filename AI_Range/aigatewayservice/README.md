# AI-Range

## AI Gateway Service

This repo contains the **AI Gateway Service** — the single audited entry
point into the tower's models (vLLM, OpenAI-compatible serving; see
[docs/range-inference-tower.html](docs/range-inference-tower.html) for the
full hardware/OS/deployment picture). It carries two independent kinds of
traffic through the same policy layer:

- **Range automation** — the AI decision engine's four modes
  (live-adaptation recommendations, qualitative assessments,
  capacity/infrastructure requests, after-action reporting), reachable via
  a REST API (instructor dashboard, EP4 report kickoff, integration tests)
  and an event-bus adapter (the automated live-adaptation loop the timeline
  engine and scoring engine consume).
- **Student chat** — an OpenAI-compatible surface Open WebUI calls on
  behalf of a student. vLLM binds loopback-only on the tower; this gateway
  is the *only* thing allowed to call it, so every guardrail (auth, quota,
  audit, prompt injection framing) lives in one place regardless of which
  student, exercise, or enclave a request comes from.

Range automation funnels through a single file — `src/aiEngineClient.js` —
which is the only place that needs to change to point at a different model
or engine. Student chat funnels through `src/chatProxy.js`.

### Layout

```
src/
  aiEngineClient.js    # range automation's model calls — recommendation/assessment/
                        # resource-request/report, structured & schema-validated
  chatProxy.js          # student chat's OpenAI-compatible surface — free-form,
                         # streaming, quota-checked, audited
  eventAdapter.js        # subscribes to StateSnapshotUpdated/ObjectiveCompleted,
                          # publishes AIRecommendationGenerated/AIAssessmentGenerated/
                          # ResourceRequestRaised, persists pending_approval entries
  upstreams.js            # model registry: logical name -> vLLM base URL + health
  quota.js                 # per-student/tenant token & concurrency limits (chat)
  audit.js                  # inference audit log (chat + range automation)
  db.js                      # lazy Postgres pool (only touched in *_STORE_MODE=postgres)
  routes.js                  # range REST endpoints (Express router)
  routes/admin.js             # instructor-facing: approval queue, quota, upstream
                               # health, audit lookup, LoRA adapter load/unload
  server.js                    # wires broker + event adapter + upstream poller + HTTP server
  config.js                     # env-driven config: services, tenants, upstreams, quota, stores
  brokers/
    inMemoryBroker.js            # dev/test pub-sub
    natsBroker.js                  # real broker adapter (EVENT_BROKER_MODE=nats)
  middleware/
    auth.js                         # requireServiceAuth / requireChatAuth / requireAdminAuth
    errorHandler.js                  # uniform { error: { code, message } } shape
    idempotency.js                    # Idempotency-Key replay cache
  schemas/
    recommendation.js, assessment.js, resourceRequest.js, report.js, validator.js
      # ajv schemas the model's tool-forced output (and REST request bodies)
      # are validated against
    guided.js
      # oneOf-restructured variants of the same schemas, for vLLM's
      # response_format guided decoding (grammar backends generally don't
      # support if/then/else) — kept equivalent via test/guidedSchemas.test.js
  store/
    jobStore.js           # async report jobs — memory or Postgres (JOB_STORE_MODE)
    approvalStore.js        # instructor approval queue — memory or Postgres
db/
  schema.sql                # Postgres schema for *_STORE_MODE=postgres
openapi/
  ai-gateway.yaml            # full REST + chat + admin API spec
docs/
  range-inference-tower.html  # hardware/OS/deployment reference for the tower this runs on
Containerfile                  # UBI9-based image (podman + quadlet on the tower)
test/
  *.test.js                     # node:test suite — no live vLLM/Postgres/NATS needed;
                                 # HTTP calls are injected via fetchImpl in every test
frontend/
  src/
    api/                          # fetch client + hand-written types mirroring the OpenAPI spec
    components/                    # HealthBanner, RecommendationForm, AssessmentForm, ReportPanel
    App.tsx                         # instructor dashboard exercising the REST endpoints below
```

### Integrating a different AI engine or model

Range automation: open `src/aiEngineClient.js` and change the four
`callXxxModel()` bodies (`callRecommendationModel`, `callAssessmentModel`,
`callResourceRequestModel`, `callReportModel`) — they currently call vLLM's
OpenAI-compatible `/v1/chat/completions` via `postChatCompletion()`/
`postStructuredChatCompletion()`. Nothing else in the service needs to
change — `eventAdapter.js`, `routes.js`, and `server.js` only ever call the
four exported functions (`recommendIntervention`, `assessActionQuality`,
`evaluateResourceNeeds`, `generateAfterActionReport`).

Each mode has:
- a fixed, versioned system prompt (bump the version string if you edit it),
- a JSON-schema-validated structured output (`src/schemas/`), additionally
  constrained at generation time via vLLM guided decoding
  (`src/schemas/guided.js`), with one retry on validation failure and a
  safe fallback (`no_action` / withheld assessment) rather than blocking
  the exercise, and
- a distinct model tier / latency budget (`MODEL_TIERS` in
  `aiEngineClient.js`, resolved from `config.modelTiers` +
  `config.upstreams`) — live adaptation is tuned for low latency, report
  generation is not.

Which logical model backs which upstream is configuration, not code — see
`UPSTREAMS_JSON`/`AI_MODEL_*`/`TENANTS_JSON` in `.env.example`.

### Running it

```bash
npm install              # pg/nats are optionalDependencies — only needed for
                          # JOB_STORE_MODE=postgres / EVENT_BROKER_MODE=nats
cp .env.example .env     # set real secrets before NODE_ENV=production
npm start                # or: npm run dev (auto-restart)
npm test                 # node:test suite — every HTTP call (vLLM, Postgres via
                          # db.js callers, admin LoRA calls) is dependency-injected
                          # in tests, so `npm test` needs no live infrastructure
```

By default everything runs in-memory (`JOB_STORE_MODE`, `AUDIT_STORE_MODE`,
`APPROVAL_STORE_MODE=memory`, `EVENT_BROKER_MODE=memory`) — fine for local
dev, but a gateway restart loses report jobs, the audit trail, and the
approval queue. Production sets these to `postgres`/`nats` (see
`.env.example` and `db/schema.sql`) since the tower's GitOps convergence
cycle restarts the gateway routinely, not just on failure.

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

| Method & path                       | Purpose                              | Auth           | Response pattern                       |
|--------------------------------------|---------------------------------------|-----------------|------------------------------------------|
| `GET /v1/health`                     | Liveness check                        | none            | `200`                                     |
| `GET /v1/ready`                      | Per-model readiness check             | none            | `200`/`503` with per-upstream status      |
| `POST /v1/recommendations`           | Live-adaptation call                  | service         | `200` sync, supports `Idempotency-Key`    |
| `POST /v1/assessments`               | Qualitative scoring, one objective    | service         | `200` sync                                |
| `POST /v1/reports`                   | Start an after-action report (EP4)    | service         | `202` + `job_id`, async                   |
| `GET /v1/reports/:job_id`            | Poll report status                    | service         | `200` with `pending`/`complete`/`failed`  |
| `GET /v1/models`                     | List chat models for the caller       | chat            | `200`, OpenAI-compatible                  |
| `POST /v1/chat/completions`          | Student chat (streaming or not)       | chat            | `200`, OpenAI-compatible / SSE            |
| `POST /v1/embeddings`                | Course-content RAG retrieval          | chat            | `200`, OpenAI-compatible                  |
| `GET/POST /v1/admin/approvals*`      | Instructor approval queue             | service or chat-admin | `200`                               |
| `GET /v1/admin/upstreams`            | Per-model readiness (instructor view) | service or chat-admin | `200`                               |
| `GET /v1/admin/quota/:studentId`     | Quota usage lookup                    | service or chat-admin | `200`                               |
| `GET /v1/admin/audit`                | Recent inference audit records        | service or chat-admin | `200`                               |
| `POST /v1/admin/lora/{load,unload}`  | Hot-load/unload a student LoRA adapter| service or chat-admin | `200`                               |

Two independent bearer-token pools, checked by `src/middleware/auth.js`:

- **service** — a named token in `config.services` (`AI_GATEWAY_API_KEY` is
  the `"control-plane"` token). Used by the range control plane and the
  instructor dashboard.
- **chat** — a per-enclave tenant token in `config.tenants`
  (`CHAT_DEFAULT_TENANT_TOKEN` by default), identifying which Open WebUI
  instance a request came from. Student identity is required in addition,
  via `X-OpenWebUI-User-Id` (and `-Email`/`-Name`/`-Role`) headers Open
  WebUI forwards when `ENABLE_FORWARD_USER_INFO_HEADERS=true` — Open WebUI
  already did the real per-student OIDC login, so the gateway trusts those
  headers rather than re-authenticating the student itself. Admin routes
  additionally accept a chat request whose forwarded role is in
  `config.admin.roles` (default `admin`, `instructor`).

Every error response has the shape `{ "error": { "code", "message" } }`.

### Student chat (`src/chatProxy.js`)

Open WebUI is configured with `OPENAI_API_BASE_URL` pointing at this
gateway, never at vLLM directly — vLLM binds loopback-only on the tower, so
this is the only path in. Every `POST /v1/chat/completions` request:

1. resolves and validates the requested `model` against the tenant's
   allowlist and current readiness (`src/upstreams.js`),
2. checks and reserves quota (`src/quota.js`) — a rolling-hour token budget
   per student and per tenant, plus a concurrent-stream cap per student,
3. strips any client-supplied `system` message and injects the fixed,
   versioned range system prompt (retrieved/pasted content is framed as
   data to discuss, never instructions to follow — students submitting
   malicious-looking content as coursework is expected, not a jailbreak),
4. clamps `temperature`/`max_tokens` to `config.chat`'s ceilings,
5. streams the response back byte-for-byte (`res.write`, no buffering) when
   `stream: true`, while best-effort-parsing usage/`finish_reason` out of
   the same SSE bytes for the audit record,
6. tears down the upstream request via `AbortController` if the client
   disconnects, so an abandoned browser tab doesn't hold a KV-cache slot
   for the rest of the generation, and
7. records one row per call to `src/audit.js` — tenant, student, model,
   token counts, latency, `finish_reason` — regardless of path taken.

### Instructor admin (`src/routes/admin.js`)

Closes a gap in the original design: `eventAdapter.js` already computed
`approval_status: "pending_approval"` for `branch_change`/`extend_time` and
low-confidence recommendations, but nothing persisted the queue or exposed
a way to act on it. `src/store/approvalStore.js` now persists every
pending-approval recommendation, and `GET/POST /v1/admin/approvals*` lists
and resolves them. The same router also exposes upstream health, quota
inspection, an audit lookup, and the LoRA adapter load/unload workflow used
by the adaptation labs (see `docs/range-inference-tower.html`, "The
adaptation lab").

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
