import pg from 'pg';
import { canonicalCode } from './dedupe.js';
import type { PromoCandidate, PromoCodeRow, PromoStatus, ScanRunInsert } from './types.js';

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
    const inserted = await client.query<{ id: number; inserted: boolean }>(
      `INSERT INTO promo_codes (
         vendor, code, category, offer_summary, redeem_url, source_url, source_type, repo_full_name,
         source_date, confidence, status, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unverified',$11)
       ON CONFLICT ((lower(vendor)), (upper(code))) DO UPDATE
       SET last_seen_at = now(),
           offer_summary = CASE WHEN length(EXCLUDED.offer_summary) > length(promo_codes.offer_summary) THEN EXCLUDED.offer_summary ELSE promo_codes.offer_summary END,
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
        candidate.redeemUrl ?? null,
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

export async function insertScanRun(pool: pg.Pool, run: ScanRunInsert): Promise<void> {
  await pool.query(
    `INSERT INTO scan_runs (query_key, surface, mode, cursor_window, etag, hits_found, new_codes, rate_limit_remaining)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [run.queryKey, run.surface, run.mode, run.cursorWindow ?? null, run.etag ?? null, run.hitsFound, run.newCodes, run.rateLimitRemaining ?? null]
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

export async function queryPromoCodes(pool: pg.Pool, filters: DashboardFilters): Promise<PromoCodeRow[]> {
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
  if (filters.confidence) add('confidence = ?', filters.confidence);
  if (filters.status) add('status = ?', filters.status);
  const sort = filters.sort === 'sightings' ? 'sighting_count DESC, last_seen_at DESC' : 'last_seen_at DESC, id DESC';
  params.push(Math.min(filters.limit ?? 100, 200));
  const limitParam = params.length;
  params.push(filters.offset ?? 0);
  const offsetParam = params.length;
  const sql = `SELECT * FROM promo_codes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${sort} LIMIT $${limitParam} OFFSET $${offsetParam}`;
  const result = await pool.query<PromoCodeRow>(sql, params);
  return result.rows;
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

export async function latestScanStatus(pool: pg.Pool): Promise<{ ranAt: string | null; rateLimitRemaining: number | null; recentRuns: number }> {
  const latest = await pool.query<{ ran_at: string; rate_limit_remaining: number | null }>(
    'SELECT ran_at, rate_limit_remaining FROM scan_runs ORDER BY ran_at DESC LIMIT 1'
  );
  const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM scan_runs WHERE ran_at > now() - interval '1 hour'`);
  return {
    ranAt: latest.rows[0]?.ran_at ?? null,
    rateLimitRemaining: latest.rows[0]?.rate_limit_remaining ?? null,
    recentRuns: Number(count.rows[0]?.count ?? 0)
  };
}

export async function latestBackfillWindow(pool: pg.Pool): Promise<string | undefined> {
  const result = await pool.query<{ cursor_window: string | null }>(
    `SELECT cursor_window FROM scan_runs
     WHERE mode = 'backfill' AND cursor_window IS NOT NULL
     ORDER BY ran_at DESC LIMIT 1`
  );
  return result.rows[0]?.cursor_window ?? undefined;
}
