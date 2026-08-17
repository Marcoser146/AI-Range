"use strict";

require("dotenv").config();

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback = []) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// JSON-shaped env vars (tenant table, per-mode model overrides) let one
// group_vars-driven deploy describe the whole tenant/model topology without
// a pile of positional env vars. Falls back to `fallback` (rather than
// throwing) on bad JSON, since a malformed override should degrade to "use
// the default topology," not take the gateway down.
function json(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[ai-gateway] config: ignoring invalid JSON in env var, using default`);
    return fallback;
  }
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const authDisabled = bool(process.env.AI_GATEWAY_AUTH_DISABLED, false);

// --- Secrets: fail closed in production, warn-and-default outside it ------
//
// A missing secret in production should stop the gateway from starting, not
// boot it with a guessable default - see requireSecret() below. In
// dev/test, a fixed fallback keeps `npm test` and local runs working without
// every contributor needing a .env file.
function requireSecret(envVar, devFallback) {
  const value = process.env[envVar];
  if (value) return value;
  if (authDisabled) return devFallback; // auth is off; value is unused
  if (isProduction) {
    throw new Error(
      `[ai-gateway] config: ${envVar} must be set in production (NODE_ENV=production). ` +
        `Refusing to start with a default secret.`
    );
  }
  return devFallback;
}

// --- Service callers (range control plane, instructor dashboard) ---------
//
// These are the trusted, already-authenticated-at-the-network-layer callers
// of the existing REST API (POST /v1/recommendations, /v1/assessments,
// /v1/reports). Each gets its own named token instead of one shared secret,
// so a leaked/rotated dashboard token doesn't require re-keying the control
// plane too. AI_GATEWAY_API_KEY is kept as the "control-plane" token for
// backward compatibility with the single-token setup this started as.
const services = {
  "control-plane": requireSecret("AI_GATEWAY_API_KEY", "change-me"),
  "instructor-dashboard": process.env.INSTRUCTOR_DASHBOARD_TOKEN || null,
};

// --- Chat tenants (one per enclave/cloud, via HWIL) ------------------------
//
// Each Open WebUI instance authenticates to the gateway with a static
// per-enclave token (its OPENAI_API_KEY). That token is what tells the
// gateway which enclave a chat request came from, before it ever looks at
// which student is attached to the request (see middleware/auth.js). Real
// deployments set TENANTS_JSON from group_vars; a single "default" tenant
// ships out of the box so local dev/test doesn't need it.
//
// Shape: { "<tenant-id>": { token, allowedModels: [...] | null (= all) } }
const defaultTenants = {
  default: {
    token: requireSecret("CHAT_DEFAULT_TENANT_TOKEN", "change-me-chat"),
    allowedModels: null,
  },
};
const tenants = json(process.env.TENANTS_JSON, defaultTenants);

// --- Model upstreams --------------------------------------------------------
//
// One entry per vLLM (or vLLM-compatible) process on the tower. Logical
// names are what the rest of the gateway/config refers to; servedModelName
// is what's passed as "model" in the OpenAI-compatible request body (it
// must match --served-model-name on that vLLM instance). Real deployments
// override this wholesale via UPSTREAMS_JSON from group_vars - this is the
// "active model set is configuration, not code" boundary.
const defaultUpstreams = {
  "gpt-oss-120b": {
    baseUrl: process.env.VLLM_GPTOSS_URL || "http://127.0.0.1:8000",
    servedModelName: "gpt-oss-120b",
    healthPath: "/health",
    guidedDecoding: true,
  },
  "mistral-small-3.1-24b": {
    baseUrl: process.env.VLLM_MISTRAL_URL || "http://127.0.0.1:8001",
    servedModelName: "mistral-small-3.1-24b",
    healthPath: "/health",
    guidedDecoding: true,
  },
  "devstral-small-2507": {
    baseUrl: process.env.VLLM_DEVSTRAL_URL || "http://127.0.0.1:8002",
    servedModelName: "devstral-small-2507",
    healthPath: "/health",
    guidedDecoding: true,
  },
  "granite-3.3-8b": {
    baseUrl: process.env.VLLM_GRANITE_URL || "http://127.0.0.1:8003",
    servedModelName: "granite-3.3-8b",
    healthPath: "/health",
    guidedDecoding: true,
  },
  "nomic-embed-text-v1.5": {
    baseUrl: process.env.VLLM_EMBED_URL || "http://127.0.0.1:8004",
    servedModelName: "nomic-embed-text-v1.5",
    healthPath: "/health",
    embedding: true,
  },
  "granite-3.3-8b-lora": {
    baseUrl: process.env.VLLM_LORA_URL || "http://127.0.0.1:8005",
    servedModelName: "granite-3.3-8b",
    healthPath: "/health",
    guidedDecoding: true,
    // student adapters are loaded at runtime and served as their own
    // "model" name on this same upstream - see routes/admin.js.
    lora: true,
  },
};
const upstreams = json(process.env.UPSTREAMS_JSON, defaultUpstreams);

// --- Per-mode model tiers ---------------------------------------------------
//
// Which upstream backs each of the four AI-engine modes. Live adaptation
// and capacity analytics share the fast/small tier because they run on the
// same telemetry cadence; assessment and report tolerate more latency.
// Chat's default model is separate - students pick from GET /v1/models.
const modelTiers = {
  liveAdaptation: process.env.AI_MODEL_LIVE || "granite-3.3-8b",
  assessment: process.env.AI_MODEL_ASSESSMENT || "mistral-small-3.1-24b",
  capacityAnalytics: process.env.AI_MODEL_CAPACITY || "granite-3.3-8b",
  report: process.env.AI_MODEL_REPORT || "gpt-oss-120b",
};
const chatDefaultModel = process.env.CHAT_DEFAULT_MODEL || "gpt-oss-120b";
const embeddingModel = process.env.EMBEDDING_MODEL || "nomic-embed-text-v1.5";

module.exports = {
  nodeEnv,
  isProduction,
  port: num(process.env.PORT, 8080),

  // legacy single-key field, kept for anything still reading config.apiKey
  // directly (also equal to services["control-plane"]).
  apiKey: services["control-plane"],
  authDisabled,
  services,
  tenants,

  eventBrokerMode: process.env.EVENT_BROKER_MODE || "memory",
  natsUrl: process.env.NATS_URL || "nats://127.0.0.1:4222",

  jobStoreMode: process.env.JOB_STORE_MODE || "memory",
  auditStoreMode: process.env.AUDIT_STORE_MODE || "memory",
  approvalStoreMode: process.env.APPROVAL_STORE_MODE || "memory",
  db: {
    url: process.env.DATABASE_URL || "",
  },

  // Live-adaptation calls must stay fast; report generation is allowed to
  // run long. Raised from the original 4000ms default: a real ~150-token
  // structured recommendation, once queued behind other requests on a
  // shared model, routinely takes longer than that even when everything is
  // healthy.
  liveCallTimeoutMs: num(process.env.AI_LIVE_CALL_TIMEOUT_MS, 8000),
  reportCallTimeoutMs: num(process.env.AI_REPORT_CALL_TIMEOUT_MS, 300000),

  defaultAutoApplyThreshold: num(process.env.DEFAULT_AUTO_APPLY_CONFIDENCE_THRESHOLD, 0.8),

  upstreams,
  modelTiers,
  chatDefaultModel,
  embeddingModel,
  upstreamPollIntervalMs: num(process.env.UPSTREAM_POLL_INTERVAL_MS, 15000),
  upstreamHealthTimeoutMs: num(process.env.UPSTREAM_HEALTH_TIMEOUT_MS, 3000),

  chat: {
    maxTokensCeiling: num(process.env.CHAT_MAX_TOKENS_CEILING, 4096),
    temperatureCeiling: num(process.env.CHAT_TEMPERATURE_CEILING, 1.5),
    systemPromptVersion: "range-chat-system@1.0.0",
  },

  quota: {
    tokensPerHourPerStudent: num(process.env.QUOTA_TOKENS_PER_HOUR_STUDENT, 200000),
    tokensPerHourPerTenant: num(process.env.QUOTA_TOKENS_PER_HOUR_TENANT, 4000000),
    maxConcurrentStreamsPerStudent: num(process.env.QUOTA_MAX_CONCURRENT_STUDENT, 2),
  },

  admin: {
    // roles (from the X-Openwebui-User-Role forwarded header) allowed to
    // call /v1/admin/*, in addition to the "instructor-dashboard" service token.
    roles: list(process.env.ADMIN_ROLES, ["admin", "instructor"]),
  },
};
