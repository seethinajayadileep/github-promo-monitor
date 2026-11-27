ALTER TABLE scan_runs
  ADD COLUMN IF NOT EXISTS rate_limit_limit INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_resource TEXT;

CREATE INDEX IF NOT EXISTS scan_runs_rate_limit_resource_idx
  ON scan_runs (rate_limit_resource, ran_at DESC)
  WHERE rate_limit_remaining IS NOT NULL;
