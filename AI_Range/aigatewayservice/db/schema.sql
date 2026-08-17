-- Schema for JOB_STORE_MODE=postgres / AUDIT_STORE_MODE=postgres /
-- APPROVAL_STORE_MODE=postgres (src/store/jobStore.js, src/audit.js,
-- src/store/approvalStore.js). Memory mode (the default) needs none of
-- this - it's only required once DATABASE_URL is set in production.
--
-- Applied via Ansible (roles/gateway or similar) against the Postgres
-- instance on the tower's U.2 array - see docs/range-inference-tower.html,
-- "GPU allocation and storage" / "Storage layout".

CREATE TABLE IF NOT EXISTS report_jobs (
    job_id       UUID PRIMARY KEY,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
    exercise_id  TEXT,
    result       JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS report_jobs_exercise_id_idx ON report_jobs (exercise_id);

CREATE TABLE IF NOT EXISTS inference_audit (
    id                 BIGSERIAL PRIMARY KEY,
    tenant             TEXT,
    student_id         TEXT,
    exercise_id        TEXT,
    mode               TEXT,          -- 'chat' | 'embedding' | 'recommendation' | 'assessment' | ...
    model              TEXT,
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    latency_ms         INTEGER,
    finish_reason      TEXT,
    prompt_version     TEXT,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inference_audit_tenant_idx ON inference_audit (tenant, recorded_at DESC);
CREATE INDEX IF NOT EXISTS inference_audit_student_idx ON inference_audit (student_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS approval_queue (
    approval_id          UUID PRIMARY KEY,
    exercise_id          TEXT,
    student_id           TEXT,
    recommendation_type  TEXT,
    target_id            TEXT,
    confidence           REAL,
    rationale            TEXT,
    reason               TEXT,
    prompt_version       TEXT,
    status               TEXT NOT NULL DEFAULT 'pending_approval'
                           CHECK (status IN ('pending_approval', 'approved', 'rejected')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at          TIMESTAMPTZ,
    resolved_by          TEXT
);

CREATE INDEX IF NOT EXISTS approval_queue_status_idx ON approval_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_queue_exercise_idx ON approval_queue (exercise_id);
