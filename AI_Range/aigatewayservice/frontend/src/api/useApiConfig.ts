import { useEffect, useState } from "react";
import type { ApiConfig } from "./client";

const STORAGE_KEY = "ai-gateway.api-config";

function loadConfig(): ApiConfig {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as ApiConfig;
    } catch {
      // fall through to defaults
    }
  }
  return { baseUrl: "/v1", apiKey: "" };
}

// Persisted client-side so the instructor only has to paste the bearer
// token once per browser. Never baked into the build, since a static
// bundle is public — this is deliberately a runtime-entered secret.
export function useApiConfig() {
  const [config, setConfig] = useState<ApiConfig>(loadConfig);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  return { config, setConfig };
}
