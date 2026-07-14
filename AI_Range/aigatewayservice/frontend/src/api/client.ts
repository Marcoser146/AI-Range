import type {
  AssessmentRequest,
  AssessmentResponse,
  ErrorResponse,
  HealthResponse,
  RecommendationRequest,
  RecommendationResponse,
  ReportJob,
  ReportJobAccepted,
  ReportRequest,
} from "./types";

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  config: ApiConfig,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const err = data as ErrorResponse | undefined;
    throw new ApiError(
      res.status,
      err?.error?.code ?? "unknown_error",
      err?.error?.message ?? `Request failed with status ${res.status}`
    );
  }

  return data as T;
}

export function getHealth(config: ApiConfig) {
  return request<HealthResponse>(config, "/health");
}

export function createRecommendation(
  config: ApiConfig,
  payload: RecommendationRequest,
  idempotencyKey?: string
) {
  return request<RecommendationResponse>(config, "/recommendations", {
    method: "POST",
    body: payload,
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

export function createAssessment(config: ApiConfig, payload: AssessmentRequest) {
  return request<AssessmentResponse>(config, "/assessments", {
    method: "POST",
    body: payload,
  });
}

export function createReport(config: ApiConfig, payload: ReportRequest) {
  return request<ReportJobAccepted>(config, "/reports", {
    method: "POST",
    body: payload,
  });
}

export function getReport(config: ApiConfig, jobId: string) {
  return request<ReportJob>(config, `/reports/${jobId}`);
}
