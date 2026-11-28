ALTER TABLE scan_lane_cursors
  ADD COLUMN IF NOT EXISTS cursor_window TEXT;

CREATE TABLE IF NOT EXISTS seen_commit_shas (
  repo_full_name TEXT NOT NULL,
  sha TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_full_name, sha)
);

CREATE INDEX IF NOT EXISTS seen_commit_shas_seen_at_idx ON seen_commit_shas (seen_at);

-- Judged LLM inputs only. The hash is stored, never the source text or a key.
CREATE TABLE IF NOT EXISTS llm_input_cache (
  input_hash TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  result_json TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (result_json IS NULL OR length(result_json) <= 4000)
);
