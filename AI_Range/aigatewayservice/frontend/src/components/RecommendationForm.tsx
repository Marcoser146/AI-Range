import { useState } from "react";
import { ApiError, createRecommendation } from "../api/client";
import type { ApiConfig } from "../api/client";
import type { RecommendationResponse, StateSnapshotObjective } from "../api/types";

const emptyObjective = (): StateSnapshotObjective => ({
  id: "",
  status: "not_started",
  blocked_minutes: 0,
});

export function RecommendationForm({ config }: { config: ApiConfig }) {
  const [exerciseId, setExerciseId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [studentActions, setStudentActions] = useState(0);
  const [objectives, setObjectives] = useState<StateSnapshotObjective[]>([emptyObjective()]);
  const [idempotencyKey, setIdempotencyKey] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecommendationResponse | null>(null);

  function updateObjective(index: number, patch: Partial<StateSnapshotObjective>) {
    setObjectives((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  }

  function addObjective() {
    setObjectives((prev) => [...prev, emptyObjective()]);
  }

  function removeObjective(index: number) {
    setObjectives((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await createRecommendation(
        config,
        {
          exercise_id: exerciseId,
          student_id: studentId || undefined,
          snapshot: {
            exercise_id: exerciseId,
            elapsed_minutes: elapsedMinutes,
            student_actions_last_5min: studentActions,
            objectives: objectives.filter((o) => o.id),
          },
        },
        idempotencyKey || undefined
      );
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2>Live-Adaptation Recommendation</h2>
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
        </div>

        <div className="field-row">
          <label>
            Elapsed minutes
            <input
              type="number"
              value={elapsedMinutes}
              onChange={(e) => setElapsedMinutes(Number(e.target.value))}
            />
          </label>
          <label>
            Student actions (last 5 min)
            <input
              type="number"
              value={studentActions}
              onChange={(e) => setStudentActions(Number(e.target.value))}
            />
          </label>
          <label>
            Idempotency key (optional)
            <input value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} />
          </label>
        </div>

        <fieldset>
          <legend>Objectives</legend>
          {objectives.map((objective, index) => (
            <div className="field-row" key={index}>
              <label>
                ID
                <input
                  value={objective.id}
                  onChange={(e) => updateObjective(index, { id: e.target.value })}
                />
              </label>
              <label>
                Status
                <select
                  value={objective.status}
                  onChange={(e) =>
                    updateObjective(index, {
                      status: e.target.value as StateSnapshotObjective["status"],
                    })
                  }
                >
                  <option value="not_started">not_started</option>
                  <option value="in_progress">in_progress</option>
                  <option value="complete">complete</option>
                </select>
              </label>
              <label>
                Blocked minutes
                <input
                  type="number"
                  value={objective.blocked_minutes ?? 0}
                  onChange={(e) =>
                    updateObjective(index, { blocked_minutes: Number(e.target.value) })
                  }
                />
              </label>
              <button type="button" className="secondary" onClick={() => removeObjective(index)}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={addObjective}>
            + Add objective
          </button>
        </fieldset>

        <button type="submit" disabled={loading}>
          {loading ? "Requesting..." : "Get recommendation"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="result">
          <div className="result-header">
            <span className={`badge badge--${result.recommendation.recommendation_type}`}>
              {result.recommendation.recommendation_type}
            </span>
            <span className="confidence">
              confidence {(result.recommendation.confidence * 100).toFixed(0)}%
            </span>
          </div>
          {result.recommendation.target_id && (
            <p>
              <strong>Target:</strong> {result.recommendation.target_id}
            </p>
          )}
          <p>{result.recommendation.rationale}</p>
          <p className="meta">
            prompt {result.prompt_version} · schema {result.schema_version} · attempts{" "}
            {result.attempts} · {new Date(result.generated_at).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}
