import pg from 'pg';
import { canonicalCode } from './dedupe.js';
import { inferRateLimitResource } from './github.js';
import { estimateLlmCostUsd, type LlmUsageRecord } from './llmUsage.js';
import { laneFromQueryKey } from './scanMeta.js';
import { sanitizeRedeemUrl } from './urls.js';
import type { PromoCandidate, PromoCodeRow, PromoStatus, RateLimitBucket, ScanRunInsert } from './types.js';

export const BACKFILL_WINDOW_COMPLETE_KEY = 'backfill-window-complete';

const { Pool } = pg;
export type DbPool = pg.Pool;

pg.types.setTypeParser(20, (value) => Number(value));

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString, max: Number(process.env.PG_POOL_SIZE ?? 5) });
}

export interface UpsertResult {
  promoCodeId: number;
  isNew: boolean;
  insertedSighting: boolean;
}

export async function upsertPromoCandidate(pool: pg.Pool, candidate: PromoCandidate): Promise<UpsertResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vendor = candidate.vendor.trim();
    const code = canonicalCode(candidate.code);
    const redeemUrl = sanitizeRedeemUrl(candidate.redeemUrl) ?? null;
    const inserted = await client.query<{ id: number; inserted: boolean }>(
      `INSERT INTO promo_codes (
         vendor, code, category, offer_summary, redeem_url, source_url, source_type, repo_full_name,
         source_date, confidence, status, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unverified',$11)
       ON CONFLICT ((lower(vendor)), (upper(code))) DO UPDATE
       SET last_seen_at = now(),
           offer_summary = CASE
             WHEN length(EXCLUDED.offer_summary) = 0 THEN promo_codes.offer_summary
             WHEN EXCLUDED.offer_summary NOT LIKE '%<%'
               AND EXCLUDED.offer_summary NOT LIKE '%**%'
               AND POSITION(chr(96) IN EXCLUDED.offer_summary) = 0 THEN EXCLUDED.offer_summary
             WHEN length(EXCLUDED.offer_summary) > length(promo_codes.offer_summary) THEN EXCLUDED.offer_summary
             ELSE promo_codes.offer_summary
           END,
           redeem_url = COALESCE(promo_codes.redeem_url, EXCLUDED.redeem_url),
           expires_at = COALESCE(promo_codes.expires_at, EXCLUDED.expires_at),
           confidence = CASE
             WHEN EXCLUDED.confidence = 'high' THEN 'high'
             WHEN promo_codes.confidence = 'high' THEN promo_codes.confidence
             WHEN EXCLUDED.confidence = 'medium' THEN 'medium'
             ELSE promo_codes.confidence
           END,
           status = CASE
             WHEN promo_codes.status IN ('expired', 'flagged') THEN promo_codes.status
             WHEN promo_codes.status = 'likely_expired' THEN 'unverified'
             ELSE promo_codes.status
           END
       RETURNING id, (xmax = 0) AS inserted`,
      [
        vendor,
        code,
        candidate.category,
        candidate.offerSummary,
        redeemUrl,
        candidate.sourceUrl,
        candidate.sourceType,
        candidate.repoFullName,
        candidate.sourceDate ?? null,
        candidate.confidence,
        candidate.expiresAt ?? null
      ]
    );
    const promoCodeId = Number(inserted.rows[0].id);
    const isNew = inserted.rows[0].inserted;

    const sighting = await client.query(
      `INSERT INTO promo_sightings (promo_code_id, source_url, source_type, repo_full_name, snippet)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (promo_code_id, source_url) DO NOTHING`,
      [promoCodeId, candidate.sourceUrl, candidate.sourceType, candidate.repoFullName, candidate.snippet.slice(0, 1000)]
    );
    const insertedSighting = (sighting.rowCount ?? 0) > 0;
    if (insertedSighting && !isNew) {
      await client.query('UPDATE promo_codes SET sighting_count = sighting_count + 1 WHERE id = $1', [promoCodeId]);
    }
    await client.query('COMMIT');
    return { promoCodeId, isNew, insertedSighting };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function pruneScanRuns(pool: pg.Pool, retentionDays = 7): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const result = await pool.query(
    "DELETE FROM scan_runs WHERE ran_at < now() - ($1::int * interval '1 day') AND query_key <> $2",
    [days, BACKFILL_WINDOW_COMPLETE_KEY]
  );
  try {
    await pool.query(
      "DELETE FROM github_rate_events WHERE occurred_at < now() - ($1::int * interval '1 day')",
      [days]
    );
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code !== '42P01') throw error;
  }
  return result.rowCount ?? 0;
}

export async function getLaneCursor(pool: pg.Pool, lane: string): Promise<number> {
  const result = await pool.query<{ next_index: number }>(
    'SELECT next_index FROM scan_lane_cursors WHERE lane = $1',
    [lane]
  );
  return Math.max(0, Number(result.rows[0]?.next_index ?? 0));
}

const FOLLOWABLE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isFollowableRepo(repo: string | undefined | null): repo is string {
  return Boolean(repo && repo !== 'unknown/unknown' && FOLLOWABLE_REPO.test(repo));
}

export async function rememberFollowedRepo(pool: pg.Pool, repoFullName: string, countNewSighting: boolean): Promise<void> {
  if (!isFollowableRepo(repoFullName)) return;
  await pool.query(
    `INSERT INTO followed_repos (repo_full_name, promo_count, last_seen_at)
     VALUES ($1, 1, now())
     ON CONFLICT (repo_full_name) DO UPDATE
     SET last_seen_at = now(),
         promo_count = followed_repos.promo_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END`,
    [repoFullName, countNewSighting]
  );
}

export async function syncFollowedRepos(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `INSERT INTO followed_repos (repo_full_name, promo_count, first_seen_at, last_seen_at)
     SELECT repo_full_name, COUNT(*)::int, MIN(first_seen_at), MAX(last_seen_at)
     FROM promo_codes
     WHERE status <> 'flagged'
       AND repo_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     GROUP BY repo_full_name
     ON CONFLICT (repo_full_name) DO UPDATE
     SET promo_count = GREATEST(followed_repos.promo_count, EXCLUDED.promo_count),
         last_seen_at = GREATEST(followed_repos.last_seen_at, EXCLUDED.last_seen_at)`
  );
  return result.rowCount ?? 0;
}

export async function listFollowedRepos(pool: pg.Pool, limit: number, exclude: string[] = []): Promise<string[]> {
  const result = await pool.query<{ repo_full_name: string }>(
    `SELECT repo_full_name
     FROM followed_repos
     WHERE NOT (repo_full_name = ANY($2::text[]))
     ORDER BY last_polled_at ASC NULLS FIRST, last_seen_at DESC
     LIMIT $1`,
    [Math.max(1, Math.floor(limit)), exclude]
  );
  return result.rows.map((row) => row.repo_full_name).filter((repo) => isFollowableRepo(repo));
}

export async function markFollowedRepoPolled(pool: pg.Pool, repoFullName: string): Promise<void> {
  if (!isFollowableRepo(repoFullName)) return;
  await pool.query('UPDATE followed_repos SET last_polled_at = now() WHERE repo_full_name = $1', [repoFullName]);
}

export async function advanceLaneCursor(pool: pg.Pool, lane: string, nextIndex: number): Promise<void> {
  await pool.query(
    `INSERT INTO scan_lane_cursors (lane, next_index, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (lane) DO UPDATE SET next_index = EXCLUDED.next_index, updated_at = now()`,
    [lane, Math.max(0, Math.floor(nextIndex))]
  );
}

function nonNegativeInt(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

export async function insertScanRun(pool: pg.Pool, run: ScanRunInsert): Promise<void> {
  await pool.query(
    `INSERT INTO scan_runs (
       query_key, surface, mode, cursor_window, etag, hits_found, new_codes,
       rate_limit_remaining, rate_limit_limit, rate_limit_resource,
       pages_scanned, reported_total, cap_saturated, rate_limited, reported_incomplete, lane
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      run.queryKey,
      run.surface,
      run.mode,
      run.cursorWindow ?? null,
      run.etag ?? null,
      run.hitsFound,
      run.newCodes,
      run.rateLimitRemaining ?? null,
      run.rateLimitLimit ?? null,
      run.rateLimitResource ?? inferRateLimitResource(run.surface),
      nonNegativeInt(run.pagesScanned),
      nonNegativeInt(run.reportedTotal),
      run.capSaturated ?? null,
      run.rateLimited ?? null,
      run.reportedIncomplete ?? null,
      run.lane ?? laneFromQueryKey(run.queryKey)
    ]
  );
}

export async function insertLlmCall(pool: pg.Pool, record: LlmUsageRecord): Promise<void> {
  const status = record.status === 'success' || record.status === 'timeout' || record.status === 'error' ? record.status : 'error';
  const cost = estimateLlmCostUsd(record.model, record);
  await pool.query(
    `INSERT INTO llm_calls (
       provider, model, status, finish_reason, failure_code,
       prompt_tokens, completion_tokens, cached_tokens, cost_usd, cost_estimated, attempt
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      record.provider,
      record.model.slice(0, 80),
      status,
      record.finishReason ? record.finishReason.slice(0, 40) : null,
      record.failureCode ? record.failureCode.slice(0, 80) : null,
      Math.max(0, Math.floor(record.promptTokens)),
      Math.max(0, Math.floor(record.completionTokens)),
      Math.max(0, Math.floor(record.cachedTokens)),
      cost.usd,
      cost.priced,
      Math.max(1, Math.floor(record.attempt))
    ]
  );
}

export async function insertLlmGateEvent(
  pool: pg.Pool,
  event: { provider: string; model: string; decision: 'accepted' | 'rejected' | 'failed'; reason?: string | null }
): Promise<void> {
  await pool.query(
    `INSERT INTO llm_gate_events (provider, model, decision, reason)
     VALUES ($1,$2,$3,$4)`,
    [
      event.provider.slice(0, 40),
      event.model.slice(0, 80),
      event.decision,
      event.reason ? event.reason.slice(0, 80) : null
    ]
  );
}

export async function insertGithubRateEvent(
  pool: pg.Pool,
  event: { kind: 'primary' | 'secondary'; status?: number; resource?: string }
): Promise<void> {
  if (event.kind !== 'primary' && event.kind !== 'secondary') return;
  const resource = event.resource ? event.resource.slice(0, 40) : null;
  await pool.query(
    `INSERT INTO github_rate_events (kind, status, resource) VALUES ($1,$2,$3)`,
    [event.kind, event.status ?? null, resource]
  );
}

export interface ExaSearchInsert {
  queryKey: string;
  vendor: string;
  status: 'ok' | 'error';
  errorCode?: string | null;
  searchType: string;
  numResultsRequested: number;
  maxAgeHours?: number | null;
  publishedWithinDays?: number | null;
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
  costUsd?: number | null;
  costSource?: 'response' | 'list-price' | null;
}

export async function insertExaSearch(pool: pg.Pool, row: ExaSearchInsert): Promise<void> {
  await pool.query(
    `INSERT INTO exa_searches (
       query_key, vendor, status, error_code, search_type, num_results_requested, max_age_hours,
       published_within_days, requests, results_returned, github_results, dropped_non_github,
       pass1_candidates, pass1_hits, gate_accepted, gate_rejected, gate_failed, gate_bypassed,
       new_codes, result_cap_full, cost_usd, cost_source
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      row.queryKey.slice(0, 80),
      row.vendor.slice(0, 100),
      row.status,
      row.errorCode ? row.errorCode.slice(0, 80) : null,
      row.searchType.slice(0, 40),
      Math.min(100, Math.max(1, Math.floor(row.numResultsRequested))),
      row.maxAgeHours ?? null,
      row.publishedWithinDays ?? null,
      Math.max(0, Math.floor(row.requests)),
      Math.max(0, Math.floor(row.resultsReturned)),
      Math.max(0, Math.floor(row.githubResults)),
      Math.max(0, Math.floor(row.droppedNonGithub)),
      Math.max(0, Math.floor(row.pass1Candidates)),
      Math.max(0, Math.floor(row.pass1Hits)),
      Math.max(0, Math.floor(row.gateAccepted)),
      Math.max(0, Math.floor(row.gateRejected)),
      Math.max(0, Math.floor(row.gateFailed)),
      Math.max(0, Math.floor(row.gateBypassed)),
      Math.max(0, Math.floor(row.newCodes)),
      row.resultCapFull,
      row.costUsd ?? null,
      row.costSource ?? null
    ]
  );
}

export async function upsertWorkerRuntime(
  pool: pg.Pool,
  input: { llmProvider: string; llmModel: string; config: unknown }
): Promise<void> {
  await pool.query(
    `INSERT INTO worker_runtime (id, reported_at, llm_provider, llm_model, config)
     VALUES (1, now(), $1, $2, $3::jsonb)
     ON CONFLICT (id) DO UPDATE
     SET reported_at = now(),
         llm_provider = EXCLUDED.llm_provider,
         llm_model = EXCLUDED.llm_model,
         config = EXCLUDED.config`,
    [input.llmProvider.slice(0, 40), input.llmModel.slice(0, 80), JSON.stringify(input.config)]
  );
}

export async function latestEtag(pool: pg.Pool, queryKey: string, surface: string): Promise<string | undefined> {
  const result = await pool.query<{ etag: string | null }>(
    `SELECT etag FROM scan_runs
     WHERE query_key = $1 AND surface = $2 AND etag IS NOT NULL
     ORDER BY ran_at DESC LIMIT 1`,
    [queryKey, surface]
  );
  return result.rows[0]?.etag ?? undefined;
}

export async function applyDailyExpiry(pool: pg.Pool): Promise<{ expired: number; likelyExpired: number }> {
  const expired = await pool.query(
    `UPDATE promo_codes SET status = 'expired'
     WHERE expires_at IS NOT NULL AND expires_at <= now() AND status <> 'expired' AND status <> 'flagged'`
  );
  const likely = await pool.query(
    `UPDATE promo_codes SET status = 'likely_expired'
     WHERE expires_at IS NULL
       AND last_seen_at < now() - interval '45 days'
       AND status NOT IN ('expired', 'likely_expired', 'flagged')`
  );
  return { expired: expired.rowCount ?? 0, likelyExpired: likely.rowCount ?? 0 };
}

export interface DashboardFilters {
  q?: string;
  vendor?: string;
  category?: string;
  sourceType?: string;
  confidence?: string;
  status?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export type NormalizedConfidenceFilter = 'high' | 'medium' | 'low' | 'all' | 'high-medium';

/** Empty/missing confidence defaults to high+medium; `all` includes low rows. */
export function normalizeConfidenceFilter(confidence?: string): NormalizedConfidenceFilter {
  if (!confidence) return 'high-medium';
  if (confidence === 'all' || confidence === 'high' || confidence === 'medium' || confidence === 'low') return confidence;
  return 'high-medium';
}

export function promoSortClause(sort?: string): string {
  if (sort === 'sightings') return 'sighting_count DESC, last_seen_at DESC, id DESC';
  if (sort === 'confidence') {
    return "CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC, id DESC";
  }
  return 'last_seen_at DESC, id DESC';
}

function buildPromoFilters(filters: DashboardFilters): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(code ILIKE $${params.length} OR vendor ILIKE $${params.length} OR repo_full_name ILIKE $${params.length} OR offer_summary ILIKE $${params.length})`);
  }
  if (filters.vendor) add('lower(vendor) = lower(?)', filters.vendor);
  if (filters.category) add('category = ?', filters.category);
  if (filters.sourceType) add('source_type = ?', filters.sourceType);
  const confidence = normalizeConfidenceFilter(filters.confidence);
  if (confidence === 'high-medium') where.push("confidence IN ('high', 'medium')");
  else if (confidence !== 'all') add('confidence = ?', confidence);
  if (filters.status) add('status = ?', filters.status);
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function queryPromoCodes(pool: pg.Pool, filters: DashboardFilters): Promise<PromoCodeRow[]> {
  const { whereSql, params } = buildPromoFilters(filters);
  const sort = promoSortClause(filters.sort || 'confidence');
  params.push(Math.min(filters.limit ?? 100, 200));
  const limitParam = params.length;
  params.push(filters.offset ?? 0);
  const offsetParam = params.length;
  const sql = `SELECT * FROM promo_codes ${whereSql} ORDER BY ${sort} LIMIT $${limitParam} OFFSET $${offsetParam}`;
  const result = await pool.query<PromoCodeRow>(sql, params);
  return result.rows;
}

export async function countPromoCodes(pool: pg.Pool, filters: DashboardFilters): Promise<number> {
  const { whereSql, params } = buildPromoFilters(filters);
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM promo_codes ${whereSql}`, params);
  return Number(result.rows[0]?.count ?? 0);
}

export async function listFilterValues(pool: pg.Pool): Promise<{ vendors: string[]; categories: string[] }> {
  const vendors = await pool.query<{ vendor: string }>('SELECT DISTINCT vendor FROM promo_codes ORDER BY vendor');
  const categories = await pool.query<{ category: string }>('SELECT DISTINCT category FROM promo_codes ORDER BY category');
  return { vendors: vendors.rows.map((row) => row.vendor), categories: categories.rows.map((row) => row.category) };
}

export async function updatePromoStatus(pool: pg.Pool, id: number, status: PromoStatus): Promise<boolean> {
  const result = await pool.query('UPDATE promo_codes SET status = $1 WHERE id = $2', [status, id]);
  return (result.rowCount ?? 0) > 0;
}

export interface ScanStatus {
  ranAt: string | null;
  rateLimitRemaining: number | null;
  recentRuns: number;
  rateLimits: {
    core?: RateLimitBucket;
    search?: RateLimitBucket;
    code_search?: RateLimitBucket;
  };
}

function toBucket(row: { ran_at: string; rate_limit_remaining: number | null; rate_limit_limit?: number | null; resource: string }): RateLimitBucket {
  return {
    remaining: row.rate_limit_remaining,
    limit: row.rate_limit_limit ?? null,
    resource: row.resource,
    at: row.ran_at
  };
}

export async function latestScanStatus(pool: pg.Pool): Promise<ScanStatus> {
  const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM scan_runs WHERE ran_at > now() - interval '1 hour'`);
  const recentRuns = Number(count.rows[0]?.count ?? 0);

  type StatusRow = {
    ran_at: string;
    rate_limit_remaining: number | null;
    rate_limit_limit?: number | null;
    rate_limit_resource?: string | null;
    surface: string;
  };

  let rows: StatusRow[] = [];
  try {
    const result = await pool.query<StatusRow>(
      `SELECT ran_at, rate_limit_remaining, rate_limit_limit, rate_limit_resource, surface
       FROM scan_runs
       WHERE rate_limit_remaining IS NOT NULL
       ORDER BY ran_at DESC
       LIMIT 80`
    );
    rows = result.rows;
  } catch {
    const result = await pool.query<StatusRow>(
      `SELECT ran_at, rate_limit_remaining, surface
       FROM scan_runs
       WHERE rate_limit_remaining IS NOT NULL
       ORDER BY ran_at DESC
       LIMIT 80`
    );
    rows = result.rows;
  }

  const rateLimits: ScanStatus['rateLimits'] = {};
  for (const row of rows) {
    const resource = inferRateLimitResource(row.surface, row.rate_limit_resource);
    if (resource === 'core' && !rateLimits.core) rateLimits.core = toBucket({ ...row, resource });
    if (resource === 'search' && !rateLimits.search) rateLimits.search = toBucket({ ...row, resource });
    if (resource === 'code_search' && !rateLimits.code_search) rateLimits.code_search = toBucket({ ...row, resource });
    if (rateLimits.core && rateLimits.search && rateLimits.code_search) break;
  }

  const latest = await pool.query<{ ran_at: string }>('SELECT ran_at FROM scan_runs ORDER BY ran_at DESC LIMIT 1');
  return {
    ranAt: latest.rows[0]?.ran_at ?? null,
    rateLimitRemaining: rateLimits.core?.remaining ?? null,
    recentRuns,
    rateLimits
  };
}

export async function latestBackfillWindow(pool: pg.Pool): Promise<string | undefined> {
  const complete = await pool.query<{ cursor_window: string | null }>(
    `SELECT cursor_window FROM scan_runs
     WHERE mode = 'backfill' AND query_key = $1 AND cursor_window IS NOT NULL
     ORDER BY ran_at DESC LIMIT 1`,
    [BACKFILL_WINDOW_COMPLETE_KEY]
  );
  if (complete.rows[0]?.cursor_window) return complete.rows[0].cursor_window;

  // Legacy fallback: no completion markers exist yet. Prefer not to restart history.
  const result = await pool.query<{ cursor_window: string | null }>(
    `SELECT cursor_window FROM scan_runs
     WHERE mode = 'backfill' AND cursor_window IS NOT NULL AND query_key <> $1
     ORDER BY ran_at DESC LIMIT 1`,
    [BACKFILL_WINDOW_COMPLETE_KEY]
  );
  return result.rows[0]?.cursor_window ?? undefined;
}
