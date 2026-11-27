CREATE TABLE IF NOT EXISTS scan_lane_cursors (
  lane TEXT PRIMARY KEY,
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_runs_retention_idx ON scan_runs (ran_at);
