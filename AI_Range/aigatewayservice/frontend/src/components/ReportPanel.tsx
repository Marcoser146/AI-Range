import { useEffect, useRef, useState } from "react";
import { ApiError, createReport, getReport } from "../api/client";
import type { ApiConfig } from "../api/client";
import type { ReportJob } from "../api/types";

const POLL_INTERVAL_MS = 2000;

export function ReportPanel({ config }: { config: ApiConfig }) {
  const [exerciseId, setExerciseId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ReportJob | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setJob(null);
    stopPolling();
    setLoading(true);

    try {
      const accepted = await createReport(config, { exercise_id: exerciseId });
      const jobId = accepted.job_id;

      pollRef.current = setInterval(async () => {
        try {
          const current = await getReport(config, jobId);
          setJob(current);
          if (current.status !== "pending") {
            stopPolling();
            setLoading(false);
          }
        } catch (err) {
          stopPolling();
          setLoading(false);
          setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Poll failed");
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setLoading(false);
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : "Request failed");
    }
  }

  return (
    <div className="panel">
      <h2>After-Action Report (EP4)</h2>
      <form onSubmit={handleSubmit}>
        <div className="field-row">
          <label>
            Exercise ID
            <input value={exerciseId} onChange={(e) => setExerciseId(e.target.value)} required />
          </label>
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "Generating..." : "Start report"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {job && (
        <div className="result">
          <div className="result-header">
            <span className={`badge badge--${job.status}`}>{job.status}</span>
            <span className="meta">job {job.job_id}</span>
          </div>
          {job.status === "pending" && <p>Waiting for the report engine...</p>}
          {job.status === "failed" && <p className="error">{job.error}</p>}
          {job.status === "complete" && job.result && (
            <>
              <p className="narrative">{job.result.narrative}</p>
              <p className="meta">
                prompt {job.result.promptVersion} · schema {job.result.schemaVersion} · completed{" "}
                {job.completed_at ? new Date(job.completed_at).toLocaleString() : ""}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
