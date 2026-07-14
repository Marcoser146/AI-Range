import { useState } from "react";
import { ApiError, createAssessment } from "../api/client";
import type { ApiConfig } from "../api/client";
import type { AssessmentDimension, AssessmentResponse } from "../api/types";

export function AssessmentForm({ config }: { config: ApiConfig }) {
  const [exerciseId, setExerciseId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [dimension, setDimension] = useState<AssessmentDimension>("methodology");
  const [submissionText, setSubmissionText] = useState("");
  const [actionLogText, setActionLogText] = useState(
    '[\n  { "type": "command", "value": "nmap -sV target" }\n]'
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssessmentResponse | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    let actionLog: Record<string, unknown>[];
    try {
      actionLog = JSON.parse(actionLogText);
    } catch {
      setError("Action log must be valid JSON (an array of objects)");
      return;
    }

    setLoading(true);
    try {
      const response = await createAssessment(config, {
        exercise_id: exerciseId,
        student_id: studentId || undefined,
        objective_id: objectiveId,
        dimension,
        action_log: actionLog,
        submission_text: submissionText || undefined,
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>Qualitative Assessment</h2>
      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <label>
            Exercise ID
            <input value={exerciseId} onChange={(e) => setExerciseId(e.target.value)} required />
          </label>
          <label>
            Student ID
            <input value={studentId} onChange={(e) => setStudentId(e.target.value)} />
          </label>
          <label>
            Objective ID
            <input value={objectiveId} onChange={(e) => setObjectiveId(e.target.value)} required />
          </label>
          <label>
            Dimension
            <select
              value={dimension}
              onChange={(e) => setDimension(e.target.value as AssessmentDimension)}
            >
              <option value="methodology">methodology</option>
              <option value="efficiency">efficiency</option>
              <option value="documentation">documentation</option>
            </select>
          </label>
        </div>

        <label>
          Submission text (optional)
          <textarea
            rows={3}
            value={submissionText}
            onChange={(e) => setSubmissionText(e.target.value)}
          />
        </label>

        <label>
          Action log (JSON array)
          <textarea
            rows={4}
            value={actionLogText}
            onChange={(e) => setActionLogText(e.target.value)}
            spellCheck={false}
          />
        </label>

        <button type="submit" disabled={loading}>
          {loading ? "Requesting..." : "Get assessment"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="result">
          <div className="result-header">
            <span className="badge">{result.assessment.dimension}</span>
            <span className="confidence">
              quality {(result.assessment.quality_score * 100).toFixed(0)}%
            </span>
          </div>
          {result.assessment.evidence && (
            <p>
              <strong>Evidence:</strong> {result.assessment.evidence}
            </p>
          )}
          <p>{result.assessment.rationale}</p>
          <p className="meta">
            prompt {result.prompt_version} · schema {result.schema_version} · attempts{" "}
            {result.attempts} · {new Date(result.generated_at).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
