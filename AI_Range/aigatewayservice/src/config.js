function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

module.exports = {
  port: Number(process.env.PORT || 8080),
  apiKey: process.env.AI_GATEWAY_API_KEY || "change-me",
  eventBrokerMode: process.env.EVENT_BROKER_MODE || "memory",
  liveCallTimeoutMs: Number(process.env.AI_LIVE_CALL_TIMEOUT_MS || 4000),
  reportCallTimeoutMs: Number(process.env.AI_REPORT_CALL_TIMEOUT_MS || 120000),
  defaultAutoApplyThreshold: Number(
    process.env.DEFAULT_AUTO_APPLY_CONFIDENCE_THRESHOLD || 0.8
  ),
  authDisabled: bool(process.env.AI_GATEWAY_AUTH_DISABLED, false),
};
