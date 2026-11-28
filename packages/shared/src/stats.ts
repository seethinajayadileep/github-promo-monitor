import { countBackfillWindowsRemaining } from './backfillWindow.js';
import { latestScanStatus, type DbPool, type ScanStatus } from './db.js';
import { EXA_COST_NOTE } from './exaSearch.js';
import { istDateString, istDayStart, shiftIstDate } from './ist.js';
import { llmRateCard } from './llmUsage.js';
import {
  estimateQueryCycle,
  followedPassEstimate,
  GITHUB_SEARCH_RESULT_CEILING,
  gapsBetweenIsoTimes,
  laneHealth,
  STATS_HONESTY,
  unopenedSearchHits,
  type LaneHealth
} from './scanMeta.js';
import type { NormalizedStatsFilters } from './statsFilters.js';
import { sanitizePublicWorkerConfig, type PublicWorkerConfig } from './workerPublicConfig.js';

export interface StatsCatalog {
  now: Date;
  searchQueryCount: number;
  codeQueryCount: number;
  watchlistRepos: string[];
  filesLoaded: boolean;
}

export interface DashboardStats {
  generatedAt: string;
  timeZone: 'Asia/Kolkata';
  filters: { from: string; to: string; lane: string; model: string; q: string };
  honesty: typeof STATS_HONESTY;
  notes: string[];
  inventory: {
    total: number;
    high: number;
    medium: number;
    low: number;
    bySource: Record<string, number>;
    byStatus: Record<string, number>;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    periods: Array<{ id: string; label: string; newCodes: number; reseens: number; newSightings: number }>;
  };
  repos: {
    promoRepos: number;
    sightingRepos: number;
    unionRepos: number;
    newToday: number;
    seenBeforeToday: number;
    newInRange: number;
  };
  followed: {
    total: number;
    neverPolled: number;
    newInRange: number;
    polledInRange: number;
    lastPolledAt: string | null;
    passesForFullVisit: number | null;
    fullVisitMs: number | null;
  };
  watchlist: {
    configured: string[];
    scannedInRange: number;
    lastByRepo: Array<{ repo: string; lastScanAt: string | null; hitsFound: number | null; newCodes: number | null }>;
  };
  remaining: {
    backfill: {
      enabled: boolean | null;
      stopDate: string | null;
      daysPerWindow: number | null;
      lastCompletedWindow: string | null;
      lastCompletedAt: string | null;
      nextWindow: string | null;
      windowsRemaining: number | null;
      calendarDaysFromNextEndToStop: number | null;
      reachedStop: boolean | null;
      currentActivityWindow: string | null;
      currentActivityAt: string | null;
      queriesPerWindow: number;
    };
    cycles: Array<{
      lane: string;
      label: string;
      queryCount: number;
      reportedQueryCount: number | null;
      nextIndex: number | null;
      nextQueryNumber: number | null;
      queriesUntilWrap: number | null;
      cursorUpdatedAt: string | null;
      nominalCycleMs: number | null;
      observedMedianGapMs: number | null;
      estimatedFullCycleMs: number | null;
      estimatedWrapMs: number | null;
      basis: string;
    }>;
    latestWindows: number;
    latestWindowsTruncated: boolean;
    hitsFetchedOnLatest: number;
    windowsWithReportedTotal: number;
    capSaturatedWindows: number;
    rateLimitedWindows: number;
    unopenedCapHits: number;
    unopenedRateLimitHits: number;
    capRows: QueryWindowRow[];
  };
  tokens: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    estimatedCostUsd: number;
    pricedRequests: number;
    unpricedRequests: number;
    success: number;
    timeout: number;
    error: number;
    byModel: TokenBucket[];
    byDay: TokenBucket[];
    byHour: TokenBucket[];
    hourWindowHours: number;
    models: string[];
    rates: ReturnType<typeof llmRateCard>;
  };
  gate: {
    accepted: number;
    rejected: number;
    failed: number;
    byReason: Array<{ decision: string; reason: string; count: number }>;
    byDay: Array<{ day: string; decision: string; count: number }>;
    recent: Array<{ decidedAt: string; provider: string; model: string; decision: string; reason: string | null }>;
  };
  lanes: Array<{
    lane: string;
    label: string;
    runs: number;
    hitsFound: number;
    legacyHits: number;
    legacyRuns: number;
    newCodes: number;
    pagesScanned: number;
    capHits: number;
    rateLimitedRuns: number;
    runsMissingPageDetail: number;
    lastScanAt: string | null;
    health: LaneHealth;
  }>;
  surfaces: Array<{
    lane: string;
    surface: string;
    runs: number;
    hitsFound: number;
    legacyHits: number;
    legacyRuns: number;
    newCodes: number;
    lastScanAt: string | null;
  }>;
  recentRuns: RecentRun[];
  rateLimits: {
    latest: ScanStatus;
    eventsInRange: Array<{ kind: string; resource: string; count: number }>;
    eventTotal: number;
  };
  runtime: {
    reportedAt: string | null;
    llmProvider: string | null;
    llmModel: string | null;
    config: PublicWorkerConfig | null;
  };
  exa: ExaStats;
}

export interface TokenBucket {
  bucket: string;
  model: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  costEstimated: boolean;
  success: number;
  timeout: number;
  error: number;
}

export interface QueryWindowRow {
  queryKey: string;
  surface: string;
  lane: string;
  mode: string;
  cursorWindow: string | null;
  ranAt: string | null;
  hitsFetched: number;
  reportedTotal: number | null;
  reportedIncomplete: boolean;
  pagesScanned: number | null;
  capSaturated: boolean;
  rateLimited: boolean;
  unopenedHits: number | null;
  unopenedReason: 'cap' | 'rate-limit' | null;
}

export interface RecentRun {
  ranAt: string | null;
  lane: string;
  queryKey: string;
  surface: string;
  mode: string;
  cursorWindow: string | null;
  hitsFound: number;
  newCodes: number;
  pagesScanned: number | null;
  reportedTotal: number | null;
  capSaturated: boolean | null;
  rateLimited: boolean | null;
}

interface SchemaFlags {
  llmCalls: boolean;
  llmGate: boolean;
  rateEvents: boolean;
  workerRuntime: boolean;
  followedRepos: boolean;
  scanDetail: boolean;
  exaSearches: boolean;
}

export interface ExaStats {
  configured: boolean | null;
  searchType: string | null;
  numResults: number | null;
  maxAgeHours: number | null;
  publishedWithinDays: number | null;
  intervalMs: number | null;
  queryCount: number | null;
  runs: number;
  okRuns: number;
  errorRuns: number;
  requests: number;
  resultsReturned: number;
  githubResults: number;
  droppedNonGithub: number;
  pass1Candidates: number;
  pass1Hits: number;
  gateAccepted: number;
  gateRejected: number;
  gateFailed: number;
  gateBypassed: number;
  newCodes: number;
  resultCapFull: number;
  costUsd: number;
  responseCostRuns: number;
  listPriceRuns: number;
  unpricedRuns: number;
  byDay: ExaBucket[];
  byHour: ExaBucket[];
  recent: ExaRun[];
  last: ExaRun | null;
}

export interface ExaBucket {
  bucket: string;
  requests: number;
  resultsReturned: number;
  githubResults: number;
  pass1Candidates: number;
  gateAccepted: number;
  gateRejected: number;
  gateFailed: number;
  newCodes: number;
  costUsd: number;
  errors: number;
}

export interface ExaRun {
  ranAt: string | null;
  queryKey: string;
  vendor: string;
  status: string;
  errorCode: string | null;
  searchType: string;
  numResultsRequested: number;
  maxAgeHours: number | null;
  publishedWithinDays: number | null;
  requests: number;
  resultsReturned: number;
  githubResults: number;
  droppedNonGithub: number;
  pass1Candidates: number;
  pass1Hits: number;
  gateAccepted: number;
  gateRejected: number;
  gateFailed: number;
  gateBypassed: number;
  newCodes: number;
  resultCapFull: boolean;
  costUsd: number | null;
  costSource: string | null;
}

const LANE_LABELS: Record<string, string> = {
  fast: 'Fast (commits and issues)',
  slow: 'Slow (code search)',
  backfill: 'Historical backfill',
  watchlist: 'Watchlist',
  followed: 'Followed repos',
  exa: 'Exa (github.com discovery)',
  other: 'Other'
};

const KNOWN_LANES = ['fast', 'slow', 'backfill', 'watchlist', 'followed', 'exa'];

function laneLabel(lane: string): string {
  return LANE_LABELS[lane] ?? lane;
}

function int(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function float(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /[T\s]/.test(text)) return parsed.toISOString();
  return text;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

export function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code === '42P01' || code === '42703';
}

function laneExpression(scanDetail: boolean): string {
  const legacy = `CASE
      WHEN query_key LIKE 'fast:%' THEN 'fast'
      WHEN query_key LIKE 'slow:%' THEN 'slow'
      WHEN query_key LIKE 'watchlist:%' THEN 'watchlist'
      WHEN query_key LIKE 'followed:%' THEN 'followed'
      WHEN query_key LIKE 'exa:%' THEN 'exa'
      WHEN query_key LIKE 'backfill:%' OR query_key = 'backfill-window-complete' THEN 'backfill'
      ELSE 'other'
    END`;
  if (!scanDetail) return legacy;
  return `CASE
      WHEN lane IS NOT NULL AND btrim(lane) <> '' THEN lane
      WHEN query_key LIKE 'fast:%' THEN 'fast'
      WHEN query_key LIKE 'slow:%' THEN 'slow'
      WHEN query_key LIKE 'watchlist:%' THEN 'watchlist'
      WHEN query_key LIKE 'followed:%' THEN 'followed'
      WHEN query_key LIKE 'exa:%' THEN 'exa'
      WHEN query_key LIKE 'backfill:%' OR query_key = 'backfill-window-complete' THEN 'backfill'
      ELSE 'other'
    END`;
}

function surfaceExpression(): string {
  return `CASE
    WHEN surface LIKE 'commits-%' THEN 'commits'
    WHEN surface = 'issues' THEN 'issues'
    WHEN surface = 'code' THEN 'code'
    WHEN surface = 'core-commits' THEN 'core-commits'
    WHEN surface = 'window-complete' THEN 'window-complete'
    WHEN surface = 'exa' THEN 'exa'
    ELSE surface
  END`;
}

async function rowsOf<T extends Record<string, unknown>>(pool: DbPool, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

async function oneOf<T extends Record<string, unknown>>(pool: DbPool, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await rowsOf<T>(pool, sql, params);
  return rows[0] ?? ({} as T);
}

function mapExaBucket(row: Record<string, unknown>): ExaBucket {
  return {
    bucket: text(row.bucket) ?? '',
    requests: int(row.requests),
    resultsReturned: int(row.results_returned),
    githubResults: int(row.github_results),
    pass1Candidates: int(row.pass1_candidates),
    gateAccepted: int(row.gate_accepted),
    gateRejected: int(row.gate_rejected),
    gateFailed: int(row.gate_failed),
    newCodes: int(row.new_codes),
    costUsd: float(row.cost_usd),
    errors: int(row.errors)
  };
}

function mapExaRun(row: Record<string, unknown>): ExaRun {
  return {
    ranAt: iso(row.ran_at),
    queryKey: text(row.query_key) ?? '',
    vendor: text(row.vendor) ?? '',
    status: text(row.status) ?? '',
    errorCode: text(row.error_code),
    searchType: text(row.search_type) ?? '',
    numResultsRequested: int(row.num_results_requested),
    maxAgeHours: row.max_age_hours == null ? null : int(row.max_age_hours),
    publishedWithinDays: row.published_within_days == null ? null : int(row.published_within_days),
    requests: int(row.requests),
    resultsReturned: int(row.results_returned),
    githubResults: int(row.github_results),
    droppedNonGithub: int(row.dropped_non_github),
    pass1Candidates: int(row.pass1_candidates),
    pass1Hits: int(row.pass1_hits),
    gateAccepted: int(row.gate_accepted),
    gateRejected: int(row.gate_rejected),
    gateFailed: int(row.gate_failed),
    gateBypassed: int(row.gate_bypassed),
    newCodes: int(row.new_codes),
    resultCapFull: bool(row.result_cap_full),
    costUsd: row.cost_usd == null ? null : float(row.cost_usd),
    costSource: text(row.cost_source)
  };
}

function emptyExa(config: PublicWorkerConfig | null): ExaStats {
  const configured = config ? config.exaConfigured === true : null;
  return {
    configured,
    searchType: configString(config, 'exaSearchType'),
    numResults: configNumber(config, 'exaNumResults'),
    maxAgeHours: configNumber(config, 'exaMaxAgeHours'),
    publishedWithinDays: configNumber(config, 'exaPublishedWithinDays'),
    intervalMs: configNumber(config, 'exaIntervalMs'),
    queryCount: configNumber(config, 'exaQueryCount'),
    runs: 0,
    okRuns: 0,
    errorRuns: 0,
    requests: 0,
    resultsReturned: 0,
    githubResults: 0,
    droppedNonGithub: 0,
    pass1Candidates: 0,
    pass1Hits: 0,
    gateAccepted: 0,
    gateRejected: 0,
    gateFailed: 0,
    gateBypassed: 0,
    newCodes: 0,
    resultCapFull: 0,
    costUsd: 0,
    responseCostRuns: 0,
    listPriceRuns: 0,
    unpricedRuns: 0,
    byDay: [],
    byHour: [],
    recent: [],
    last: null
  };
}

function configNumber(config: PublicWorkerConfig | null, key: keyof PublicWorkerConfig): number | null {
  const value = config?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function configString(config: PublicWorkerConfig | null, key: keyof PublicWorkerConfig): string | null {
  const value = config?.[key];
  return typeof value === 'string' && value.length ? value : null;
}

function intervalFor(lane: string, config: PublicWorkerConfig | null): number | null {
  if (lane === 'fast') return configNumber(config, 'fastLaneIntervalMs');
  if (lane === 'slow') return configNumber(config, 'slowLaneIntervalMs');
  if (lane === 'backfill') return configNumber(config, 'backfillIntervalMs');
  if (lane === 'watchlist' || lane === 'followed') return configNumber(config, 'watchlistIntervalMs');
  if (lane === 'exa') return configNumber(config, 'exaIntervalMs');
  return null;
}

export function summarizeQueryWindows(rows: QueryWindowRow[], truncated = false): {
  latestWindows: number;
  latestWindowsTruncated: boolean;
  hitsFetchedOnLatest: number;
  windowsWithReportedTotal: number;
  capSaturatedWindows: number;
  rateLimitedWindows: number;
  unopenedCapHits: number;
  unopenedRateLimitHits: number;
} {
  let unopenedCapHits = 0;
  let unopenedRateLimitHits = 0;
  let hitsFetchedOnLatest = 0;
  let windowsWithReportedTotal = 0;
  let capSaturatedWindows = 0;
  let rateLimitedWindows = 0;
  for (const row of rows) {
    hitsFetchedOnLatest += row.hitsFetched;
    if (row.reportedTotal != null) windowsWithReportedTotal += 1;
    if (row.capSaturated) capSaturatedWindows += 1;
    if (row.rateLimited) rateLimitedWindows += 1;
    if (row.unopenedReason === 'cap' && row.unopenedHits) unopenedCapHits += row.unopenedHits;
    if (row.unopenedReason === 'rate-limit' && row.unopenedHits) unopenedRateLimitHits += row.unopenedHits;
  }
  return {
    latestWindows: rows.length,
    latestWindowsTruncated: truncated,
    hitsFetchedOnLatest,
    windowsWithReportedTotal,
    capSaturatedWindows,
    rateLimitedWindows,
    unopenedCapHits,
    unopenedRateLimitHits
  };
}

function mapWindow(row: Record<string, unknown>): QueryWindowRow {
  const hitsFetched = int(row.hits_found);
  const reportedTotal = row.reported_total == null ? null : int(row.reported_total);
  const capSaturated = bool(row.cap_saturated);
  const rateLimited = bool(row.rate_limited);
  const unopened = unopenedSearchHits({ hitsFetched, reportedTotal, capSaturated, rateLimited });
  return {
    queryKey: text(row.query_key) ?? '',
    surface: text(row.surface) ?? '',
    lane: text(row.derived_lane) ?? 'other',
    mode: text(row.mode) ?? '',
    cursorWindow: text(row.cursor_window),
    ranAt: iso(row.ran_at),
    hitsFetched,
    reportedTotal,
    reportedIncomplete: bool(row.reported_incomplete),
    pagesScanned: row.pages_scanned == null ? null : int(row.pages_scanned),
    capSaturated,
    rateLimited,
    unopenedHits: unopened.hits,
    unopenedReason: unopened.reason
  };
}

function emptyTokens(): DashboardStats['tokens'] {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    success: 0,
    timeout: 0,
    error: 0,
    byModel: [],
    byDay: [],
    byHour: [],
    hourWindowHours: 72,
    models: llmRateCard().map((entry) => entry.model),
    rates: llmRateCard()
  };
}

function mapTokenRow(row: Record<string, unknown>, bucket: string): TokenBucket {
  return {
    bucket,
    model: text(row.model) ?? '',
    provider: text(row.provider) ?? '',
    requests: int(row.requests),
    promptTokens: int(row.prompt_tokens),
    completionTokens: int(row.completion_tokens),
    cachedTokens: int(row.cached_tokens),
    estimatedCostUsd: float(row.estimated_cost_usd),
    costEstimated: bool(row.cost_estimated),
    success: int(row.success),
    timeout: int(row.timeout),
    error: int(row.error)
  };
}

const TOKEN_COLUMNS = `model,
  MIN(provider) AS provider,
  BOOL_OR(cost_estimated) AS cost_estimated,
  COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
  COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
  COALESCE(SUM(cost_usd) FILTER (WHERE cost_estimated), 0)::float8 AS estimated_cost_usd,
  COUNT(*)::int AS requests,
  COUNT(*) FILTER (WHERE status = 'success')::int AS success,
  COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeout,
  COUNT(*) FILTER (WHERE status = 'error')::int AS error`;

export async function loadDashboardStats(
  pool: DbPool,
  filters: NormalizedStatsFilters,
  catalog: StatsCatalog
): Promise<DashboardStats> {
  const notes: string[] = [];
  const note = (message: string) => {
    if (!notes.includes(message)) notes.push(message);
  };

  const probe = await oneOf<Record<string, unknown>>(pool, `/* stats-probe */
    SELECT
      to_regclass('public.llm_calls') IS NOT NULL AS llm_calls,
      to_regclass('public.llm_gate_events') IS NOT NULL AS llm_gate,
      to_regclass('public.github_rate_events') IS NOT NULL AS rate_events,
      to_regclass('public.worker_runtime') IS NOT NULL AS worker_runtime,
      to_regclass('public.followed_repos') IS NOT NULL AS followed_repos,
      to_regclass('public.exa_searches') IS NOT NULL AS exa_searches,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scan_runs' AND column_name = 'pages_scanned'
      ) AS scan_detail`);
  const flags: SchemaFlags = {
    llmCalls: bool(probe.llm_calls),
    llmGate: bool(probe.llm_gate),
    rateEvents: bool(probe.rate_events),
    workerRuntime: bool(probe.worker_runtime),
    followedRepos: bool(probe.followed_repos),
    scanDetail: bool(probe.scan_detail),
    exaSearches: bool(probe.exa_searches)
  };
  if (!flags.llmCalls || !flags.llmGate || !flags.scanDetail) {
    note('Usage and scan-detail tables are missing until migration 006_stats_telemetry.sql has been applied. Counts that depend on them stay at zero.');
  }
  if (!flags.scanDetail) note(STATS_HONESTY.historicalScans);
  note(STATS_HONESTY.historicalTokens);

  const today = istDateString(catalog.now);
  const tomorrow = shiftIstDate(today, 1);
  const yesterday = shiftIstDate(today, -1);
  const prev7 = shiftIstDate(today, -7);
  const prev30 = shiftIstDate(today, -30);
  const periodParams = [
    istDayStart(today),
    istDayStart(tomorrow),
    istDayStart(yesterday),
    istDayStart(prev7),
    istDayStart(prev30),
    filters.start,
    filters.end
  ];

  const inventoryRow = await oneOf<Record<string, unknown>>(pool, `/* stats-inventory */
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE confidence = 'high')::int AS high,
      COUNT(*) FILTER (WHERE confidence = 'medium')::int AS medium,
      COUNT(*) FILTER (WHERE confidence = 'low')::int AS low,
      COUNT(*) FILTER (WHERE source_type = 'code')::int AS source_code,
      COUNT(*) FILTER (WHERE source_type = 'commit')::int AS source_commit,
      COUNT(*) FILTER (WHERE source_type = 'issue')::int AS source_issue,
      COUNT(*) FILTER (WHERE source_type = 'watchlist')::int AS source_watchlist,
      COUNT(*) FILTER (WHERE status = 'active')::int AS status_active,
      COUNT(*) FILTER (WHERE status = 'unverified')::int AS status_unverified,
      COUNT(*) FILTER (WHERE status = 'likely_expired')::int AS status_likely_expired,
      COUNT(*) FILTER (WHERE status = 'expired')::int AS status_expired,
      COUNT(*) FILTER (WHERE status = 'flagged')::int AS status_flagged,
      MIN(first_seen_at) AS first_seen_at,
      MAX(last_seen_at) AS last_seen_at
    FROM promo_codes`);

  const periodRow = await oneOf<Record<string, unknown>>(pool, `/* stats-periods */
    SELECT
      COUNT(*) FILTER (WHERE first_seen_at >= $1 AND first_seen_at < $2)::int AS new_today,
      COUNT(*) FILTER (WHERE last_seen_at >= $1 AND last_seen_at < $2 AND first_seen_at < $1)::int AS reseen_today,
      COUNT(*) FILTER (WHERE first_seen_at >= $3 AND first_seen_at < $1)::int AS new_yesterday,
      COUNT(*) FILTER (WHERE last_seen_at >= $3 AND last_seen_at < $1 AND first_seen_at < $3)::int AS reseen_yesterday,
      COUNT(*) FILTER (WHERE first_seen_at >= $4 AND first_seen_at < $1)::int AS new_prev7,
      COUNT(*) FILTER (WHERE last_seen_at >= $4 AND last_seen_at < $1 AND first_seen_at < $4)::int AS reseen_prev7,
      COUNT(*) FILTER (WHERE first_seen_at >= $5 AND first_seen_at < $1)::int AS new_prev30,
      COUNT(*) FILTER (WHERE last_seen_at >= $5 AND last_seen_at < $1 AND first_seen_at < $5)::int AS reseen_prev30,
      COUNT(*) FILTER (WHERE first_seen_at >= $6 AND first_seen_at < $7)::int AS new_range,
      COUNT(*) FILTER (WHERE last_seen_at >= $6 AND last_seen_at < $7 AND first_seen_at < $6)::int AS reseen_range
    FROM promo_codes`, periodParams);

  const sightingRow = await oneOf<Record<string, unknown>>(pool, `/* stats-sightings */
    SELECT
      COUNT(*) FILTER (WHERE discovered_at >= $1 AND discovered_at < $2)::int AS sightings_today,
      COUNT(*) FILTER (WHERE discovered_at >= $3 AND discovered_at < $1)::int AS sightings_yesterday,
      COUNT(*) FILTER (WHERE discovered_at >= $4 AND discovered_at < $1)::int AS sightings_prev7,
      COUNT(*) FILTER (WHERE discovered_at >= $5 AND discovered_at < $1)::int AS sightings_prev30,
      COUNT(*) FILTER (WHERE discovered_at >= $6 AND discovered_at < $7)::int AS sightings_range
    FROM promo_sightings`, periodParams);

  const repoCounts = await oneOf<Record<string, unknown>>(pool, `/* stats-repo-counts */
    SELECT
      (SELECT COUNT(DISTINCT repo_full_name)::int FROM promo_codes
        WHERE repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') AS promo_repos,
      (SELECT COUNT(DISTINCT repo_full_name)::int FROM promo_sightings
        WHERE repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') AS sighting_repos`);

  const unionSql = flags.followedRepos
    ? `/* stats-repos */
      WITH appearances AS (
        SELECT repo_full_name, first_seen_at AS seen_at FROM promo_codes
        UNION ALL
        SELECT repo_full_name, discovered_at FROM promo_sightings
        UNION ALL
        SELECT repo_full_name, first_seen_at FROM followed_repos
      ),
      cleaned AS (
        SELECT repo_full_name, MIN(seen_at) AS first_seen
        FROM appearances
        WHERE repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
        GROUP BY repo_full_name
      )
      SELECT
        COUNT(*)::int AS union_repos,
        COUNT(*) FILTER (WHERE first_seen >= $1 AND first_seen < $2)::int AS new_today,
        COUNT(*) FILTER (WHERE first_seen < $1)::int AS seen_before_today,
        COUNT(*) FILTER (WHERE first_seen >= $3 AND first_seen < $4)::int AS new_in_range
      FROM cleaned`
    : `/* stats-repos */
      WITH appearances AS (
        SELECT repo_full_name, first_seen_at AS seen_at FROM promo_codes
        UNION ALL
        SELECT repo_full_name, discovered_at FROM promo_sightings
      ),
      cleaned AS (
        SELECT repo_full_name, MIN(seen_at) AS first_seen
        FROM appearances
        WHERE repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
        GROUP BY repo_full_name
      )
      SELECT
        COUNT(*)::int AS union_repos,
        COUNT(*) FILTER (WHERE first_seen >= $1 AND first_seen < $2)::int AS new_today,
        COUNT(*) FILTER (WHERE first_seen < $1)::int AS seen_before_today,
        COUNT(*) FILTER (WHERE first_seen >= $3 AND first_seen < $4)::int AS new_in_range
      FROM cleaned`;
  const repoRow = await oneOf<Record<string, unknown>>(pool, unionSql, [
    istDayStart(today),
    istDayStart(tomorrow),
    filters.start,
    filters.end
  ]);

  let followed: DashboardStats['followed'] = {
    total: 0,
    neverPolled: 0,
    newInRange: 0,
    polledInRange: 0,
    lastPolledAt: null,
    passesForFullVisit: null,
    fullVisitMs: null
  };
  if (flags.followedRepos) {
    const followedRow = await oneOf<Record<string, unknown>>(pool, `/* stats-followed */
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE last_polled_at IS NULL)::int AS never_polled,
        COUNT(*) FILTER (WHERE first_seen_at >= $1 AND first_seen_at < $2)::int AS new_in_range,
        COUNT(*) FILTER (WHERE last_polled_at >= $1 AND last_polled_at < $2)::int AS polled_in_range,
        MAX(last_polled_at) AS last_polled_at
      FROM followed_repos`, [filters.start, filters.end]);
    followed = {
      total: int(followedRow.total),
      neverPolled: int(followedRow.never_polled),
      newInRange: int(followedRow.new_in_range),
      polledInRange: int(followedRow.polled_in_range),
      lastPolledAt: iso(followedRow.last_polled_at),
      passesForFullVisit: null,
      fullVisitMs: null
    };
  } else {
    note('Followed-repo polling totals need the followed_repos table.');
  }

  const watchlistLatest = await rowsOf<Record<string, unknown>>(pool, `/* stats-watchlist-latest */
    SELECT DISTINCT ON (query_key) query_key, ran_at, hits_found, new_codes
    FROM scan_runs
    WHERE query_key LIKE 'watchlist:%'
    ORDER BY query_key, ran_at DESC`);
  const watchlistRange = await oneOf<Record<string, unknown>>(pool, `/* stats-watchlist-range */
    SELECT COUNT(DISTINCT query_key)::int AS repos
    FROM scan_runs
    WHERE query_key LIKE 'watchlist:%' AND ran_at >= $1 AND ran_at < $2`, [filters.start, filters.end]);
  const watchlistByKey = new Map(watchlistLatest.map((row) => [text(row.query_key) ?? '', row]));

  const completion = await oneOf<Record<string, unknown>>(pool, `/* stats-backfill-complete */
    SELECT cursor_window, ran_at
    FROM scan_runs
    WHERE query_key = 'backfill-window-complete' AND cursor_window IS NOT NULL
    ORDER BY ran_at DESC
    LIMIT 1`);
  const activity = await oneOf<Record<string, unknown>>(pool, `/* stats-backfill-activity */
    SELECT cursor_window, ran_at
    FROM scan_runs
    WHERE mode = 'backfill' AND query_key <> 'backfill-window-complete' AND cursor_window IS NOT NULL
    ORDER BY ran_at DESC
    LIMIT 1`);
  const cursors = await rowsOf<Record<string, unknown>>(pool, `/* stats-cursors */
    SELECT lane, next_index, updated_at FROM scan_lane_cursors`);

  let runtimeConfig: PublicWorkerConfig | null = null;
  let runtimeReportedAt: string | null = null;
  let runtimeProvider: string | null = null;
  let runtimeModel: string | null = null;
  if (flags.workerRuntime) {
    const runtime = await oneOf<Record<string, unknown>>(pool, `/* stats-runtime */
      SELECT reported_at, llm_provider, llm_model, config FROM worker_runtime WHERE id = 1`);
    if (runtime.config != null || runtime.reported_at != null) {
      runtimeConfig = sanitizePublicWorkerConfig(runtime.config);
      runtimeReportedAt = iso(runtime.reported_at);
      const provider = text(runtime.llm_provider);
      const model = text(runtime.llm_model);
      runtimeProvider = provider && provider.length <= 64 ? provider : null;
      runtimeModel = model && model.length <= 64 ? model : null;
    }
  }
  if (!runtimeConfig) {
    note('The worker has not reported its running config yet. Intervals, page caps, and backfill window size appear after the next worker start. Cycle times that need an interval stay unknown until then.');
  }

  const perScan = configNumber(runtimeConfig, 'maxFollowedReposPerScan');
  const watchInterval = configNumber(runtimeConfig, 'watchlistIntervalMs');
  const pass = followedPassEstimate(followed.total, perScan, watchInterval);
  followed.passesForFullVisit = pass.passes;
  followed.fullVisitMs = pass.durationMs;

  const laneExpr = laneExpression(flags.scanDetail);
  const detailColumns = flags.scanDetail
    ? 'pages_scanned, reported_total, cap_saturated, rate_limited, reported_incomplete'
    : 'NULL::int AS pages_scanned, NULL::int AS reported_total, NULL::boolean AS cap_saturated, NULL::boolean AS rate_limited, NULL::boolean AS reported_incomplete';

  const openedHitsSql = `COALESCE(SUM(hits_found) FILTER (WHERE pages_scanned IS NOT NULL AND hits_found <= ${GITHUB_SEARCH_RESULT_CEILING}), 0)::bigint`;
  const legacyHitsSql = `COALESCE(SUM(hits_found) FILTER (WHERE pages_scanned IS NULL OR hits_found > ${GITHUB_SEARCH_RESULT_CEILING}), 0)::bigint`;
  const legacyRunsSql = `COUNT(*) FILTER (WHERE pages_scanned IS NULL OR hits_found > ${GITHUB_SEARCH_RESULT_CEILING})::bigint`;
  const laneRows = await rowsOf<Record<string, unknown>>(pool, `/* stats-lane-summary */
    SELECT derived_lane AS lane,
      COUNT(*)::bigint AS runs,
      ${openedHitsSql} AS hits_found,
      ${legacyHitsSql} AS legacy_hits,
      ${legacyRunsSql} AS legacy_runs,
      COALESCE(SUM(new_codes), 0)::bigint AS new_codes,
      COALESCE(SUM(pages_scanned), 0)::bigint AS pages_scanned,
      COUNT(*) FILTER (WHERE cap_saturated IS TRUE)::bigint AS cap_hits,
      COUNT(*) FILTER (WHERE rate_limited IS TRUE)::bigint AS rate_limited_runs,
      COUNT(*) FILTER (WHERE pages_scanned IS NULL)::bigint AS runs_missing_page_detail,
      MAX(ran_at) AS last_scan_at
    FROM (
      SELECT hits_found, new_codes, ran_at, ${detailColumns}, ${laneExpr} AS derived_lane
      FROM scan_runs
      WHERE ran_at >= $1 AND ran_at < $2
    ) scans
    WHERE ($3 = '' OR derived_lane = $3)
    GROUP BY derived_lane
    ORDER BY derived_lane`, [filters.start, filters.end, filters.lane]);

  const surfaceRows = await rowsOf<Record<string, unknown>>(pool, `/* stats-surfaces */
    SELECT derived_lane AS lane,
      surface_group AS surface,
      COUNT(*)::bigint AS runs,
      ${openedHitsSql} AS hits_found,
      ${legacyHitsSql} AS legacy_hits,
      ${legacyRunsSql} AS legacy_runs,
      COALESCE(SUM(new_codes), 0)::bigint AS new_codes,
      MAX(ran_at) AS last_scan_at
    FROM (
      SELECT hits_found, new_codes, ran_at, ${detailColumns}, ${laneExpr} AS derived_lane, ${surfaceExpression()} AS surface_group
      FROM scan_runs
      WHERE ran_at >= $1 AND ran_at < $2
    ) scans
    WHERE ($3 = '' OR derived_lane = $3)
    GROUP BY derived_lane, surface_group
    ORDER BY derived_lane, surface_group`, [filters.start, filters.end, filters.lane]);

  const like = filters.q ? `%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : '';
  const recentRows = await rowsOf<Record<string, unknown>>(pool, `/* stats-recent-runs */
    SELECT ran_at, query_key, surface, mode, cursor_window, hits_found, new_codes,
      ${detailColumns}, ${laneExpr} AS derived_lane
    FROM scan_runs
    WHERE ran_at >= $1 AND ran_at < $2
      AND ($3 = '' OR ${laneExpr} = $3)
      AND (
        $4 = ''
        OR query_key ILIKE $4 ESCAPE '\\'
        OR surface ILIKE $4 ESCAPE '\\'
        OR COALESCE(cursor_window, '') ILIKE $4 ESCAPE '\\'
      )
    ORDER BY ran_at DESC
    LIMIT 50`, [filters.start, filters.end, filters.lane, like]);

  let windowRows: QueryWindowRow[] = [];
  let windowsTruncated = false;
  if (flags.scanDetail) {
    const latest = await rowsOf<Record<string, unknown>>(pool, `/* stats-latest-windows */
      SELECT * FROM (
        SELECT DISTINCT ON (query_key, surface, COALESCE(cursor_window, ''))
          query_key, surface, mode, cursor_window, ran_at, hits_found,
          pages_scanned, reported_total, cap_saturated, rate_limited, reported_incomplete,
          ${laneExpr} AS derived_lane
        FROM scan_runs
        WHERE ran_at >= $1 AND ran_at < $2
          AND query_key <> 'backfill-window-complete'
        ORDER BY query_key, surface, COALESCE(cursor_window, ''), ran_at DESC
      ) latest
      WHERE ($3 = '' OR derived_lane = $3)
      LIMIT 2000`, [filters.start, filters.end, filters.lane]);
    windowsTruncated = latest.length === 2000;
    windowRows = latest.map((row) => mapWindow(row));
    if (windowsTruncated) {
      note('The latest-window sample hit 2,000 query windows. Unopened-hit totals below cover that sample, not every stored window.');
    }
  }

  const windowSummary = summarizeQueryWindows(windowRows, windowsTruncated);
  const capRows = windowRows
    .filter((row) => row.capSaturated || row.rateLimited)
    .sort((a, b) => (b.ranAt ?? '').localeCompare(a.ranAt ?? ''))
    .slice(0, 40);

  const fastGaps = await rowsOf<Record<string, unknown>>(pool, `/* stats-fast-gaps */
    SELECT ran_at FROM scan_runs
    WHERE query_key LIKE 'fast:%' AND surface LIKE 'commits-%' AND mode = 'live'
      AND ran_at >= $1 AND ran_at < $2
    ORDER BY ran_at DESC
    LIMIT 40`, [filters.start, filters.end]);
  const slowGaps = await rowsOf<Record<string, unknown>>(pool, `/* stats-slow-gaps */
    SELECT ran_at FROM scan_runs
    WHERE query_key LIKE 'slow:%' AND surface = 'code' AND mode = 'live'
      AND ran_at >= $1 AND ran_at < $2
    ORDER BY ran_at DESC
    LIMIT 40`, [filters.start, filters.end]);

  const cursorByLane = new Map(cursors.map((row) => [text(row.lane) ?? '', row]));
  const fastCursor = cursorByLane.get('fast');
  const slowCursor = cursorByLane.get('slow');
  const reportedSearch = configNumber(runtimeConfig, 'searchQueryCount');
  const reportedCode = configNumber(runtimeConfig, 'codeQueryCount');
  const fastCycle = estimateQueryCycle({
    queryCount: catalog.searchQueryCount,
    nextIndex: fastCursor ? int(fastCursor.next_index) : null,
    intervalMs: configNumber(runtimeConfig, 'fastLaneIntervalMs'),
    observedGapsMs: gapsBetweenIsoTimes(fastGaps.map((row) => iso(row.ran_at) ?? ''))
  });
  const slowCycle = estimateQueryCycle({
    queryCount: catalog.codeQueryCount,
    nextIndex: slowCursor ? int(slowCursor.next_index) : null,
    intervalMs: configNumber(runtimeConfig, 'slowLaneIntervalMs'),
    observedGapsMs: gapsBetweenIsoTimes(slowGaps.map((row) => iso(row.ran_at) ?? ''))
  });

  const stopDate = configString(runtimeConfig, 'backfillStopDate');
  const daysPerWindow = configNumber(runtimeConfig, 'backfillDaysPerWindow');
  const backfillEnabled = runtimeConfig ? runtimeConfig.backfillEnabled === true : null;
  const lastCompletedWindow = text(completion.cursor_window);
  let backfillProgress: ReturnType<typeof countBackfillWindowsRemaining> | null = null;
  if (stopDate && daysPerWindow && daysPerWindow > 0) {
    backfillProgress = countBackfillWindowsRemaining({
      lastCompletedWindow: lastCompletedWindow ?? undefined,
      daysPerWindow,
      stopDate,
      now: catalog.now,
      startOverride: configString(runtimeConfig, 'backfillStartDate') ?? undefined
    });
  }

  let tokens = emptyTokens();
  if (flags.llmCalls) {
    const totals = await oneOf<Record<string, unknown>>(pool, `/* stats-tokens */
      SELECT
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(cost_usd) FILTER (WHERE cost_estimated), 0)::float8 AS estimated_cost_usd,
        COUNT(*)::int AS requests,
        COUNT(*) FILTER (WHERE cost_estimated)::int AS priced_requests,
        COUNT(*) FILTER (WHERE NOT cost_estimated)::int AS unpriced_requests,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success,
        COUNT(*) FILTER (WHERE status = 'timeout')::int AS timeout,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error
      FROM llm_calls
      WHERE called_at >= $1 AND called_at < $2
        AND ($3 = '' OR model = $3)`, [filters.start, filters.end, filters.model]);
    const byModel = await rowsOf<Record<string, unknown>>(pool, `/* stats-token-models */
      SELECT ${TOKEN_COLUMNS}
      FROM llm_calls
      WHERE called_at >= $1 AND called_at < $2
        AND ($3 = '' OR model = $3)
      GROUP BY model
      ORDER BY requests DESC, model`, [filters.start, filters.end, filters.model]);
    const byDay = await rowsOf<Record<string, unknown>>(pool, `/* stats-token-days */
      SELECT to_char(date_trunc('day', called_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
        ${TOKEN_COLUMNS}
      FROM llm_calls
      WHERE called_at >= $1 AND called_at < $2
        AND ($3 = '' OR model = $3)
      GROUP BY 1, model
      ORDER BY 1 DESC, model`, [filters.start, filters.end, filters.model]);
    const byHour = await rowsOf<Record<string, unknown>>(pool, `/* stats-token-hours */
      SELECT to_char(date_trunc('hour', called_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:00') AS hour,
        ${TOKEN_COLUMNS}
      FROM llm_calls
      WHERE called_at >= GREATEST($1::timestamptz, $2::timestamptz - interval '72 hours')
        AND called_at < $2
        AND ($3 = '' OR model = $3)
      GROUP BY 1, model
      ORDER BY 1 DESC, model`, [filters.start, filters.end, filters.model]);
    const modelRows = await rowsOf<Record<string, unknown>>(pool, `/* stats-token-model-names */
      SELECT DISTINCT model FROM llm_calls ORDER BY model`);
    const knownModels = new Set<string>([...llmRateCard().map((entry) => entry.model), ...modelRows.map((row) => text(row.model) ?? '').filter(Boolean)]);
    tokens = {
      requests: int(totals.requests),
      promptTokens: int(totals.prompt_tokens),
      completionTokens: int(totals.completion_tokens),
      cachedTokens: int(totals.cached_tokens),
      estimatedCostUsd: float(totals.estimated_cost_usd),
      pricedRequests: int(totals.priced_requests),
      unpricedRequests: int(totals.unpriced_requests),
      success: int(totals.success),
      timeout: int(totals.timeout),
      error: int(totals.error),
      byModel: byModel.map((row) => mapTokenRow(row, text(row.model) ?? '')),
      byDay: byDay.map((row) => mapTokenRow(row, text(row.model) ?? '')).map((row, index) => ({ ...row, bucket: text(byDay[index]?.day) ?? '' })),
      byHour: byHour.map((row, index) => ({ ...mapTokenRow(row, text(row.model) ?? ''), bucket: text(byHour[index]?.hour) ?? '' })),
      hourWindowHours: 72,
      models: [...knownModels].sort(),
      rates: llmRateCard()
    };
  }

  let gate: DashboardStats['gate'] = { accepted: 0, rejected: 0, failed: 0, byReason: [], byDay: [], recent: [] };
  if (flags.llmGate) {
    const totals = await oneOf<Record<string, unknown>>(pool, `/* stats-gate */
      SELECT
        COUNT(*) FILTER (WHERE decision = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE decision = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE decision = 'failed')::int AS failed
      FROM llm_gate_events
      WHERE decided_at >= $1 AND decided_at < $2
        AND ($3 = '' OR model = $3)`, [filters.start, filters.end, filters.model]);
    const byReason = await rowsOf<Record<string, unknown>>(pool, `/* stats-gate-reasons */
      SELECT decision, COALESCE(reason, '') AS reason, COUNT(*)::int AS count
      FROM llm_gate_events
      WHERE decided_at >= $1 AND decided_at < $2
        AND ($3 = '' OR model = $3)
      GROUP BY decision, reason
      ORDER BY count DESC, decision
      LIMIT 40`, [filters.start, filters.end, filters.model]);
    const byDay = await rowsOf<Record<string, unknown>>(pool, `/* stats-gate-days */
      SELECT to_char(date_trunc('day', decided_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
        decision,
        COUNT(*)::int AS count
      FROM llm_gate_events
      WHERE decided_at >= $1 AND decided_at < $2
        AND ($3 = '' OR model = $3)
      GROUP BY 1, decision
      ORDER BY 1 DESC, decision`, [filters.start, filters.end, filters.model]);
    const recent = await rowsOf<Record<string, unknown>>(pool, `/* stats-gate-recent */
      SELECT decided_at, provider, model, decision, reason
      FROM llm_gate_events
      WHERE decided_at >= $1 AND decided_at < $2
        AND ($3 = '' OR model = $3)
        AND (
          $4 = ''
          OR COALESCE(reason, '') ILIKE $4 ESCAPE '\\'
          OR decision ILIKE $4 ESCAPE '\\'
          OR model ILIKE $4 ESCAPE '\\'
        )
      ORDER BY decided_at DESC
      LIMIT 50`, [filters.start, filters.end, filters.model, like]);
    gate = {
      accepted: int(totals.accepted),
      rejected: int(totals.rejected),
      failed: int(totals.failed),
      byReason: byReason.map((row) => ({ decision: text(row.decision) ?? '', reason: text(row.reason) ?? '', count: int(row.count) })),
      byDay: byDay.map((row) => ({ day: text(row.day) ?? '', decision: text(row.decision) ?? '', count: int(row.count) })),
      recent: recent.map((row) => ({
        decidedAt: iso(row.decided_at) ?? '',
        provider: text(row.provider) ?? '',
        model: text(row.model) ?? '',
        decision: text(row.decision) ?? '',
        reason: text(row.reason)
      }))
    };
  }

  let rateEvents: DashboardStats['rateLimits']['eventsInRange'] = [];
  let eventTotal = 0;
  if (flags.rateEvents) {
    const eventRows = await rowsOf<Record<string, unknown>>(pool, `/* stats-rate-events */
      SELECT kind, COALESCE(resource, 'unknown') AS resource, COUNT(*)::int AS count
      FROM github_rate_events
      WHERE occurred_at >= $1 AND occurred_at < $2
      GROUP BY kind, resource
      ORDER BY count DESC, kind`, [filters.start, filters.end]);
    rateEvents = eventRows.map((row) => ({ kind: text(row.kind) ?? '', resource: text(row.resource) ?? 'unknown', count: int(row.count) }));
    eventTotal = rateEvents.reduce((sum, row) => sum + row.count, 0);
  } else {
    note('GitHub rate-limit events are stored after migration 006_stats_telemetry.sql. Until the worker records new 429s, this list stays empty. The bucket snapshot still comes from the latest scan_runs rate-limit columns.');
  }

  const rateLimits = await latestScanStatus(pool);
  const laneByName = new Map(laneRows.map((row) => [text(row.lane) ?? '', row]));
  const laneNames = filters.lane ? [filters.lane] : KNOWN_LANES;
  for (const row of laneRows) {
    const name = text(row.lane) ?? '';
    if (name && !laneNames.includes(name)) laneNames.push(name);
  }
  const lanes = laneNames.map((lane) => {
    const row = laneByName.get(lane);
    const lastScanAt = iso(row?.last_scan_at);
    return {
      lane,
      label: laneLabel(lane),
      runs: int(row?.runs),
      hitsFound: int(row?.hits_found),
      legacyHits: int(row?.legacy_hits),
      legacyRuns: int(row?.legacy_runs),
      newCodes: int(row?.new_codes),
      pagesScanned: int(row?.pages_scanned),
      capHits: int(row?.cap_hits),
      rateLimitedRuns: int(row?.rate_limited_runs),
      runsMissingPageDetail: int(row?.runs_missing_page_detail),
      lastScanAt,
      health: laneHealth({
        lastScanAt,
        intervalMs: intervalFor(lane, runtimeConfig),
        capHits: int(row?.cap_hits),
        rateLimitedRuns: int(row?.rate_limited_runs),
        now: catalog.now
      })
    };
  });

  const periods = [
    { id: 'today', label: `Today (${today} IST)`, newKey: 'new_today', reseenKey: 'reseen_today', sightingKey: 'sightings_today' },
    { id: 'yesterday', label: `Yesterday (${yesterday} IST)`, newKey: 'new_yesterday', reseenKey: 'reseen_yesterday', sightingKey: 'sightings_yesterday' },
    { id: 'previous-7', label: 'Previous 7 IST days, excluding today', newKey: 'new_prev7', reseenKey: 'reseen_prev7', sightingKey: 'sightings_prev7' },
    { id: 'previous-30', label: 'Previous 30 IST days, excluding today', newKey: 'new_prev30', reseenKey: 'reseen_prev30', sightingKey: 'sightings_prev30' },
    { id: 'range', label: `Selected range (${filters.from} to ${filters.to} IST)`, newKey: 'new_range', reseenKey: 'reseen_range', sightingKey: 'sightings_range' }
  ];

  let exaStats = emptyExa(runtimeConfig);
  if (flags.exaSearches) {
    const totals = await oneOf<Record<string, unknown>>(pool, `/* stats-exa */
      SELECT
        COUNT(*)::int AS runs,
        COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_runs,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error_runs,
        COALESCE(SUM(requests), 0)::int AS requests,
        COALESCE(SUM(results_returned), 0)::int AS results_returned,
        COALESCE(SUM(github_results), 0)::int AS github_results,
        COALESCE(SUM(dropped_non_github), 0)::int AS dropped_non_github,
        COALESCE(SUM(pass1_candidates), 0)::int AS pass1_candidates,
        COALESCE(SUM(pass1_hits), 0)::int AS pass1_hits,
        COALESCE(SUM(gate_accepted), 0)::int AS gate_accepted,
        COALESCE(SUM(gate_rejected), 0)::int AS gate_rejected,
        COALESCE(SUM(gate_failed), 0)::int AS gate_failed,
        COALESCE(SUM(gate_bypassed), 0)::int AS gate_bypassed,
        COALESCE(SUM(new_codes), 0)::int AS new_codes,
        COUNT(*) FILTER (WHERE result_cap_full)::int AS result_cap_full,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COUNT(*) FILTER (WHERE cost_source = 'response')::int AS response_cost_runs,
        COUNT(*) FILTER (WHERE cost_source = 'list-price')::int AS list_price_runs,
        COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_runs
      FROM exa_searches
      WHERE ran_at >= $1 AND ran_at < $2`, [filters.start, filters.end]);
    const byDay = await rowsOf<Record<string, unknown>>(pool, `/* stats-exa-days */
      SELECT to_char(date_trunc('day', ran_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
        COALESCE(SUM(requests), 0)::int AS requests,
        COALESCE(SUM(results_returned), 0)::int AS results_returned,
        COALESCE(SUM(github_results), 0)::int AS github_results,
        COALESCE(SUM(pass1_candidates), 0)::int AS pass1_candidates,
        COALESCE(SUM(gate_accepted), 0)::int AS gate_accepted,
        COALESCE(SUM(gate_rejected), 0)::int AS gate_rejected,
        COALESCE(SUM(gate_failed), 0)::int AS gate_failed,
        COALESCE(SUM(new_codes), 0)::int AS new_codes,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors
      FROM exa_searches
      WHERE ran_at >= $1 AND ran_at < $2
      GROUP BY 1
      ORDER BY 1 DESC`, [filters.start, filters.end]);
    const byHour = await rowsOf<Record<string, unknown>>(pool, `/* stats-exa-hours */
      SELECT to_char(date_trunc('hour', ran_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:00') AS bucket,
        COALESCE(SUM(requests), 0)::int AS requests,
        COALESCE(SUM(results_returned), 0)::int AS results_returned,
        COALESCE(SUM(github_results), 0)::int AS github_results,
        COALESCE(SUM(pass1_candidates), 0)::int AS pass1_candidates,
        COALESCE(SUM(gate_accepted), 0)::int AS gate_accepted,
        COALESCE(SUM(gate_rejected), 0)::int AS gate_rejected,
        COALESCE(SUM(gate_failed), 0)::int AS gate_failed,
        COALESCE(SUM(new_codes), 0)::int AS new_codes,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors
      FROM exa_searches
      WHERE ran_at >= GREATEST($1::timestamptz, $2::timestamptz - interval '72 hours')
        AND ran_at < $2
      GROUP BY 1
      ORDER BY 1 DESC`, [filters.start, filters.end]);
    const recent = await rowsOf<Record<string, unknown>>(pool, `/* stats-exa-recent */
      SELECT ran_at, query_key, vendor, status, error_code, search_type, num_results_requested,
        max_age_hours, published_within_days, requests, results_returned, github_results, dropped_non_github,
        pass1_candidates, pass1_hits, gate_accepted, gate_rejected, gate_failed, gate_bypassed, new_codes,
        result_cap_full, cost_usd, cost_source
      FROM exa_searches
      WHERE ran_at >= $1 AND ran_at < $2
        AND (
          $3 = ''
          OR vendor ILIKE $3 ESCAPE '\\'
          OR query_key ILIKE $3 ESCAPE '\\'
          OR COALESCE(error_code, '') ILIKE $3 ESCAPE '\\'
          OR status ILIKE $3 ESCAPE '\\'
        )
      ORDER BY ran_at DESC
      LIMIT 40`, [filters.start, filters.end, like]);
    const mappedRecent = recent.map(mapExaRun);
    exaStats = {
      ...emptyExa(runtimeConfig),
      runs: int(totals.runs),
      okRuns: int(totals.ok_runs),
      errorRuns: int(totals.error_runs),
      requests: int(totals.requests),
      resultsReturned: int(totals.results_returned),
      githubResults: int(totals.github_results),
      droppedNonGithub: int(totals.dropped_non_github),
      pass1Candidates: int(totals.pass1_candidates),
      pass1Hits: int(totals.pass1_hits),
      gateAccepted: int(totals.gate_accepted),
      gateRejected: int(totals.gate_rejected),
      gateFailed: int(totals.gate_failed),
      gateBypassed: int(totals.gate_bypassed),
      newCodes: int(totals.new_codes),
      resultCapFull: int(totals.result_cap_full),
      costUsd: float(totals.cost_usd),
      responseCostRuns: int(totals.response_cost_runs),
      listPriceRuns: int(totals.list_price_runs),
      unpricedRuns: int(totals.unpriced_runs),
      byDay: byDay.map(mapExaBucket),
      byHour: byHour.map(mapExaBucket),
      recent: mappedRecent,
      last: mappedRecent[0] ?? null
    };
  } else {
    note('Exa search rows appear after migration 006_stats_telemetry.sql. Until then this section only shows whether the worker reported Exa as configured.');
  }
  note(EXA_COST_NOTE);
  note('Exa is restricted to github.com and does not replace GitHub commit, issue, code, watchlist, followed-repo, or backfill scans. Search returns at most 100 results and has no next page.');

  if (!catalog.filesLoaded) {
    note('vendors.json could not be read in this process, so vendor-query cycle length is unknown.');
  } else {
    note('Vendor-query counts come from vendors.json shipped with this dashboard build. They match the worker when both run the same revision.');
  }
  note('Scan run rows older than the worker retention window are deleted, except backfill window-completion markers. LLM usage and gate rows are kept. A wide date range will not bring pruned scans back.');
  note('Newly seen repos are owner/name values whose earliest stored appearance falls in the window. That is discovery inside this system, not a GitHub-wide list of repos that became available.');
  note('Individual pushes are not stored. A new sighting is a new source URL. A last-seen update is a canonical promo touched again, including codes first seen before the window.');
  if (lanes.some((lane) => lane.legacyRuns > 0)) note(STATS_HONESTY.legacyHits);

  return {
    generatedAt: catalog.now.toISOString(),
    timeZone: 'Asia/Kolkata',
    filters: { from: filters.from, to: filters.to, lane: filters.lane, model: filters.model, q: filters.q },
    honesty: STATS_HONESTY,
    notes,
    inventory: {
      total: int(inventoryRow.total),
      high: int(inventoryRow.high),
      medium: int(inventoryRow.medium),
      low: int(inventoryRow.low),
      bySource: {
        code: int(inventoryRow.source_code),
        commit: int(inventoryRow.source_commit),
        issue: int(inventoryRow.source_issue),
        watchlist: int(inventoryRow.source_watchlist)
      },
      byStatus: {
        active: int(inventoryRow.status_active),
        unverified: int(inventoryRow.status_unverified),
        likely_expired: int(inventoryRow.status_likely_expired),
        expired: int(inventoryRow.status_expired),
        flagged: int(inventoryRow.status_flagged)
      },
      firstSeenAt: iso(inventoryRow.first_seen_at),
      lastSeenAt: iso(inventoryRow.last_seen_at),
      periods: periods.map((period) => ({
        id: period.id,
        label: period.label,
        newCodes: int(periodRow[period.newKey]),
        reseens: int(periodRow[period.reseenKey]),
        newSightings: int(sightingRow[period.sightingKey])
      }))
    },
    repos: {
      promoRepos: int(repoCounts.promo_repos),
      sightingRepos: int(repoCounts.sighting_repos),
      unionRepos: int(repoRow.union_repos),
      newToday: int(repoRow.new_today),
      seenBeforeToday: int(repoRow.seen_before_today),
      newInRange: int(repoRow.new_in_range)
    },
    followed,
    watchlist: {
      configured: catalog.watchlistRepos,
      scannedInRange: int(watchlistRange.repos),
      lastByRepo: catalog.watchlistRepos.map((repo) => {
        const row = watchlistByKey.get(`watchlist:${repo}`);
        return {
          repo,
          lastScanAt: iso(row?.ran_at),
          hitsFound: row ? int(row.hits_found) : null,
          newCodes: row ? int(row.new_codes) : null
        };
      })
    },
    remaining: {
      backfill: {
        enabled: backfillEnabled,
        stopDate,
        daysPerWindow,
        lastCompletedWindow,
        lastCompletedAt: iso(completion.ran_at),
        nextWindow: backfillProgress?.nextWindow ? `${backfillProgress.nextWindow.start}..${backfillProgress.nextWindow.end}` : null,
        windowsRemaining: backfillProgress?.windowsRemaining ?? null,
        calendarDaysFromNextEndToStop: backfillProgress?.calendarDaysFromNextEndToStop ?? null,
        reachedStop: backfillProgress?.reachedStop ?? null,
        currentActivityWindow: text(activity.cursor_window),
        currentActivityAt: iso(activity.ran_at),
        queriesPerWindow: catalog.searchQueryCount
      },
      cycles: [
        {
          lane: 'fast',
          label: 'Fast lane vendor-query cycle',
          reportedQueryCount: reportedSearch,
          cursorUpdatedAt: iso(fastCursor?.updated_at),
          ...fastCycle
        },
        {
          lane: 'slow',
          label: 'Slow lane code-search cycle',
          reportedQueryCount: reportedCode,
          cursorUpdatedAt: iso(slowCursor?.updated_at),
          ...slowCycle
        }
      ],
      ...windowSummary,
      capRows
    },
    tokens,
    gate,
    lanes,
    surfaces: surfaceRows.map((row) => ({
      lane: text(row.lane) ?? '',
      surface: text(row.surface) ?? '',
      runs: int(row.runs),
      hitsFound: int(row.hits_found),
      legacyHits: int(row.legacy_hits),
      legacyRuns: int(row.legacy_runs),
      newCodes: int(row.new_codes),
      lastScanAt: iso(row.last_scan_at)
    })),
    recentRuns: recentRows.map((row) => ({
      ranAt: iso(row.ran_at),
      lane: text(row.derived_lane) ?? '',
      queryKey: text(row.query_key) ?? '',
      surface: text(row.surface) ?? '',
      mode: text(row.mode) ?? '',
      cursorWindow: text(row.cursor_window),
      hitsFound: int(row.hits_found),
      newCodes: int(row.new_codes),
      pagesScanned: row.pages_scanned == null ? null : int(row.pages_scanned),
      reportedTotal: row.reported_total == null ? null : int(row.reported_total),
      capSaturated: row.cap_saturated == null ? null : bool(row.cap_saturated),
      rateLimited: row.rate_limited == null ? null : bool(row.rate_limited)
    })),
    rateLimits: {
      latest: {
        ranAt: rateLimits.ranAt ? iso(rateLimits.ranAt) : null,
        rateLimitRemaining: rateLimits.rateLimitRemaining,
        recentRuns: rateLimits.recentRuns,
        rateLimits: rateLimits.rateLimits
      },
      eventsInRange: rateEvents,
      eventTotal
    },
    runtime: {
      reportedAt: runtimeReportedAt,
      llmProvider: runtimeProvider,
      llmModel: runtimeModel,
      config: runtimeConfig
    },
    exa: exaStats
  };
}
