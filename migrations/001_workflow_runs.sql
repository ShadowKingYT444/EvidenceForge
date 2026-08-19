CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  packet_draft JSONB NOT NULL DEFAULT '{"sources":[]}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1,
  objection_dispositions JSONB,
  access_token_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_runs_updated_at_idx ON workflow_runs (updated_at);
CREATE INDEX IF NOT EXISTS workflow_runs_token_digest_idx ON workflow_runs (access_token_digest);
