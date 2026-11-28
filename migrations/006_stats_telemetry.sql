-- Usage for each LLM HTTP attempt. Prompts, keys, and candidate text are never stored.
CREATE TABLE IF NOT EXISTS llm_calls (
  id BIGSERIAL PRIMARY KEY,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'timeout', 'error')),
  finish_reason TEXT,
  failure_code TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cached_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  cost_usd NUMERIC(14, 8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  cost_estimated BOOLEAN NOT NULL DEFAULT false,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  CHECK (finish_reason IS NULL OR length(finish_reason) <= 40),
  CHECK (failure_code IS NULL OR length(failure_code) <= 80)
);

CREATE INDEX IF NOT EXISTS llm_calls_called_at_idx ON llm_calls (called_at DESC);
CREATE INDEX IF NOT EXISTS llm_calls_model_called_at_idx ON llm_calls (model, called_at DESC);

-- Gate outcome per candidate. Reasons are short codes, not snippet text.
CREATE TABLE IF NOT EXISTS llm_gate_events (
  id BIGSERIAL PRIMARY KEY,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'failed')),
  reason TEXT,
  CHECK (reason IS NULL OR length(reason) <= 80)
);

CREATE INDEX IF NOT EXISTS llm_gate_events_decided_at_idx ON llm_gate_events (decided_at DESC);
CREATE INDEX IF NOT EXISTS llm_gate_events_decision_idx ON llm_gate_events (decision, decided_at DESC);

-- GitHub primary and secondary rate-limit events. No tokens or request URLs.
CREATE TABLE IF NOT EXISTS github_rate_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'secondary')),
  status INTEGER,
  resource TEXT,
  CHECK (resource IS NULL OR length(resource) <= 40)
);

CREATE INDEX IF NOT EXISTS github_rate_events_occurred_idx ON github_rate_events (occurred_at DESC);

-- One row describing the non-secret worker settings currently in effect.
CREATE TABLE IF NOT EXISTS worker_runtime (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  llm_provider TEXT NOT NULL,
  llm_model TEXT NOT NULL,
  config JSONB NOT NULL
);

ALTER TABLE scan_runs
  ADD COLUMN IF NOT EXISTS pages_scanned INTEGER,
  ADD COLUMN IF NOT EXISTS reported_total INTEGER,
  ADD COLUMN IF NOT EXISTS cap_saturated BOOLEAN,
  ADD COLUMN IF NOT EXISTS rate_limited BOOLEAN,
  ADD COLUMN IF NOT EXISTS reported_incomplete BOOLEAN,
  ADD COLUMN IF NOT EXISTS lane TEXT;

CREATE INDEX IF NOT EXISTS scan_runs_lane_ran_at_idx ON scan_runs (lane, ran_at DESC);

-- One Exa search attempt. No API key, prompt, or page text.
CREATE TABLE IF NOT EXISTS exa_searches (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_key TEXT NOT NULL,
  vendor TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT,
  search_type TEXT NOT NULL,
  num_results_requested INTEGER NOT NULL CHECK (num_results_requested BETWEEN 1 AND 100),
  max_age_hours INTEGER,
  published_within_days INTEGER,
  requests INTEGER NOT NULL DEFAULT 1 CHECK (requests >= 0),
  results_returned INTEGER NOT NULL DEFAULT 0 CHECK (results_returned >= 0),
  github_results INTEGER NOT NULL DEFAULT 0 CHECK (github_results >= 0),
  dropped_non_github INTEGER NOT NULL DEFAULT 0 CHECK (dropped_non_github >= 0),
  pass1_candidates INTEGER NOT NULL DEFAULT 0 CHECK (pass1_candidates >= 0),
  pass1_hits INTEGER NOT NULL DEFAULT 0 CHECK (pass1_hits >= 0),
  gate_accepted INTEGER NOT NULL DEFAULT 0 CHECK (gate_accepted >= 0),
  gate_rejected INTEGER NOT NULL DEFAULT 0 CHECK (gate_rejected >= 0),
  gate_failed INTEGER NOT NULL DEFAULT 0 CHECK (gate_failed >= 0),
  gate_bypassed INTEGER NOT NULL DEFAULT 0 CHECK (gate_bypassed >= 0),
  new_codes INTEGER NOT NULL DEFAULT 0 CHECK (new_codes >= 0),
  result_cap_full BOOLEAN NOT NULL DEFAULT false,
  cost_usd NUMERIC(14, 8),
  cost_source TEXT,
  CHECK (error_code IS NULL OR length(error_code) <= 80),
  CHECK (cost_source IS NULL OR cost_source IN ('response', 'list-price')),
  CHECK (cost_usd IS NULL OR cost_usd >= 0)
);

CREATE INDEX IF NOT EXISTS exa_searches_ran_at_idx ON exa_searches (ran_at DESC);
