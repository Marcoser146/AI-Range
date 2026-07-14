// Mirrors openapi/ai-gateway.yaml. Kept hand-written and minimal rather than
// codegen'd since the gateway's schema surface is small and stable.

export interface StateSnapshotObjective {
  id: string;
  status: "not_started" | "in_progress" | "complete";
  blocked_minutes?: number;
}

export interface StateSnapshot {
  exercise_id: string;
  elapsed_minutes?: number;
  objectives: StateSnapshotObjective[];
  student_actions_last_5min?: number;
}

export interface RecommendationRequest {
  exercise_id: string;
  student_id?: string;
  snapshot: StateSnapshot;
  scenario_constraints?: Record<string, unknown>;
  recent_recommendations?: Record<string, unknown>[];
}

export type RecommendationType =
  | "inject_hint"
  | "difficulty_adjust"
  | "branch_change"
  | "extend_time"
  | "no_action";

export interface Recommendation {
  recommendation_type: RecommendationType;
  target_id?: string;
  confidence: number;
  rationale: string;
}

export interface RecommendationResponse {
  exercise_id: string;
  student_id?: string;
  recommendation: Recommendation;
  prompt_version: string;
  schema_version: string;
  attempts: number;
  generated_at: string;
}

export type AssessmentDimension = "methodology" | "efficiency" | "documentation";

export interface AssessmentRequest {
  exercise_id: string;
  student_id?: string;
  objective_id: string;
  dimension?: AssessmentDimension;
  action_log: Record<string, unknown>[];
  submission_text?: string;
}

export interface Assessment {
  objective_id: string;
  quality_score: number;
  dimension: AssessmentDimension;
  evidence?: string;
  rationale: string;
}

export interface AssessmentResponse {
  exercise_id: string;
  student_id?: string;
  assessment: Assessment;
  prompt_version: string;
  schema_version: string;
  attempts: number;
  generated_at: string;
}

export interface ReportRequest {
  exercise_id: string;
  mode?: "post_exercise_report";
  state_snapshots?: StateSnapshot[];
  recommendations?: Recommendation[];
  assessments?: Assessment[];
  final_scores?: Record<string, unknown>;
}

export interface ReportJobAccepted {
  job_id: string;
  status: "pending";
  poll_url: string;
}

export interface ReportJobResult {
  narrative: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface ReportJob {
  job_id: string;
  status: "pending" | "complete" | "failed";
  result: ReportJobResult | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface HealthResponse {
  status: string;
  service: string;
  time: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
