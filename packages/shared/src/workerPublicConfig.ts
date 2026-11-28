const NUMBER_KEYS = [
  'fastLaneIntervalMs',
  'slowLaneIntervalMs',
  'watchlistIntervalMs',
  'backfillIntervalMs',
  'searchPageSize',
  'backfillDaysPerWindow',
  'backfillMinimumRateLimitPercent',
  'liveMinimumRateLimitPercent',
  'maxCommitDetailsPerScan',
  'maxCodeFilesPerScan',
  'maxCommitSearchPages',
  'maxIssueSearchPages',
  'maxCodeSearchPages',
  'liveCommitWindowDays',
  'maxFollowedReposPerScan',
  'followedRepoCommitPageSize',
  'maxFollowedCommitDetailsPerRepo',
  'maxFollowedCommitDetailsPerScan',
  'scanRunRetentionDays',
  'searchQueryCount',
  'codeQueryCount',
  'vendorCount',
  'watchlistCount',
  'githubTokenCount',
  'staticWatchlistCommitPageSize',
  'exaIntervalMs',
  'exaNumResults',
  'exaMaxAgeHours',
  'exaPublishedWithinDays',
  'exaQueryCount',
  'exaTimeoutMs'
] as const;

const BOOLEAN_KEYS = ['backfillEnabled', 'exaConfigured'] as const;
const STRING_KEYS = ['backfillStopDate', 'backfillStartDate', 'llmProvider', 'llmModel', 'exaSearchType'] as const;

export const PUBLIC_WORKER_CONFIG_KEYS = [...NUMBER_KEYS, ...BOOLEAN_KEYS, ...STRING_KEYS] as const;

export type PublicWorkerConfigKey = (typeof PUBLIC_WORKER_CONFIG_KEYS)[number];
export type PublicWorkerConfig = Record<PublicWorkerConfigKey, number | boolean | string | null>;

const SECRET_TEXT = /sk-|ghp_|gho_|github_pat_|bearer\s+|api[_-]?key|postgres:\/\/|password|secret|token/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Keep only the public tuning fields. Anything else, including secrets, is dropped. */
export function sanitizePublicWorkerConfig(input: unknown): PublicWorkerConfig {
  const source = asRecord(input);
  const config = {} as PublicWorkerConfig;
  for (const key of NUMBER_KEYS) {
    const raw = source[key];
    if (raw == null || raw === '') {
      config[key] = null;
      continue;
    }
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    config[key] = Number.isFinite(parsed) ? parsed : null;
  }
  for (const key of BOOLEAN_KEYS) {
    const value = source[key];
    config[key] = typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null;
  }
  for (const key of STRING_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') {
      config[key] = null;
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 || SECRET_TEXT.test(trimmed)) {
      config[key] = null;
      continue;
    }
    config[key] = trimmed;
  }
  return config;
}
