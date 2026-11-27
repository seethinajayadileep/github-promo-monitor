CREATE TABLE IF NOT EXISTS promo_codes (
  id BIGSERIAL PRIMARY KEY,
  vendor TEXT NOT NULL,
  code TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  offer_summary TEXT NOT NULL DEFAULT '',
  redeem_url TEXT,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('code', 'commit', 'issue', 'watchlist')),
  repo_full_name TEXT NOT NULL,
  source_date TIMESTAMPTZ,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('active', 'unverified', 'likely_expired', 'expired', 'flagged')),
  expires_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sighting_count INTEGER NOT NULL DEFAULT 1 CHECK (sighting_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_vendor_code_unique
  ON promo_codes (lower(vendor), upper(code));

CREATE INDEX IF NOT EXISTS promo_codes_vendor_idx ON promo_codes (lower(vendor));
CREATE INDEX IF NOT EXISTS promo_codes_status_idx ON promo_codes (status);
CREATE INDEX IF NOT EXISTS promo_codes_confidence_idx ON promo_codes (confidence);
CREATE INDEX IF NOT EXISTS promo_codes_last_seen_idx ON promo_codes (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS promo_codes_search_idx ON promo_codes USING gin (
  to_tsvector('english', vendor || ' ' || code || ' ' || offer_summary || ' ' || repo_full_name)
);

CREATE TABLE IF NOT EXISTS promo_sightings (
  id BIGSERIAL PRIMARY KEY,
  promo_code_id BIGINT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('code', 'commit', 'issue', 'watchlist')),
  repo_full_name TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promo_sightings_unique_source
  ON promo_sightings (promo_code_id, source_url);
CREATE INDEX IF NOT EXISTS promo_sightings_discovered_idx ON promo_sightings (discovered_at DESC);
CREATE INDEX IF NOT EXISTS promo_sightings_repo_idx ON promo_sightings (repo_full_name);

CREATE TABLE IF NOT EXISTS scan_runs (
  id BIGSERIAL PRIMARY KEY,
  query_key TEXT NOT NULL,
  surface TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'backfill')),
  cursor_window TEXT,
  etag TEXT,
  hits_found INTEGER NOT NULL DEFAULT 0,
  new_codes INTEGER NOT NULL DEFAULT 0,
  rate_limit_remaining INTEGER,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_runs_ran_at_idx ON scan_runs (ran_at DESC);
CREATE INDEX IF NOT EXISTS scan_runs_query_idx ON scan_runs (query_key, mode, ran_at DESC);
