CREATE TABLE IF NOT EXISTS followed_repos (
  repo_full_name TEXT PRIMARY KEY,
  promo_count INTEGER NOT NULL DEFAULT 1 CHECK (promo_count >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS followed_repos_last_polled_idx ON followed_repos (last_polled_at);

INSERT INTO followed_repos (repo_full_name, promo_count, first_seen_at, last_seen_at)
SELECT repo_full_name,
       COUNT(*)::int,
       MIN(first_seen_at),
       MAX(last_seen_at)
FROM promo_codes
WHERE status <> 'flagged'
  AND repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
GROUP BY repo_full_name
ON CONFLICT (repo_full_name) DO NOTHING;
