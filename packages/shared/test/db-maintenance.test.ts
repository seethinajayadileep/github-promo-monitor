import { describe, expect, it, vi } from 'vitest';
import {
  advanceLaneCursor,
  getLaneCursor,
  isFollowableRepo,
  listFollowedRepos,
  markFollowedRepoPolled,
  pruneScanRuns,
  rememberFollowedRepo,
  upsertPromoCandidate
} from '../src/db.js';
import type { PromoCandidate } from '../src/types.js';

describe('scan lane cursors and retention', () => {
  it('reads and advances persistent lane cursor offsets', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const pool = { query } as never;
    await expect(getLaneCursor(pool, 'fast')).resolves.toBe(0);
    await advanceLaneCursor(pool, 'fast', 9);
    expect(query.mock.calls[0][0]).toContain('scan_lane_cursors');
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT (lane)');
    expect(query.mock.calls[1][1]).toEqual(['fast', 9]);
  });

  it('prunes scan_runs with a configurable retention window', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 12 });
    const pool = { query } as never;
    await expect(pruneScanRuns(pool, 7)).resolves.toBe(12);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM scan_runs'), [7, 'backfill-window-complete']);
  });
});

describe('followed repos', () => {
  it('remembers only owner/name repos that can be polled later', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const pool = { query } as never;
    expect(isFollowableRepo('acme/promo-notes')).toBe(true);
    expect(isFollowableRepo('unknown/unknown')).toBe(false);
    expect(isFollowableRepo('not a repo')).toBe(false);
    await rememberFollowedRepo(pool, 'acme/promo-notes', true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO followed_repos'), ['acme/promo-notes', true]);
    query.mockClear();
    await rememberFollowedRepo(pool, 'unknown/unknown', true);
    expect(query).not.toHaveBeenCalled();
  });

  it('lists the stalest followed repos and can mark one polled', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ repo_full_name: 'acme/promo-notes' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const pool = { query } as never;
    await expect(listFollowedRepos(pool, 30, ['mlh/keep'])).resolves.toEqual(['acme/promo-notes']);
    expect(query.mock.calls[0][0]).toContain('last_polled_at ASC NULLS FIRST');
    expect(query.mock.calls[0][1]).toEqual([30, ['mlh/keep']]);
    await markFollowedRepoPolled(pool, 'acme/promo-notes');
    expect(query.mock.calls[1][1]).toEqual(['acme/promo-notes']);
  });
});

describe('promo upsert sanitization', () => {
  it('never persists unsafe redeem URLs and prefers clean summaries in SQL', async () => {
    const calls: Array<[string, unknown[]?]> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push([sql, params]);
        if (sql.includes('INSERT INTO promo_codes')) return { rows: [{ id: 1, inserted: true }] };
        if (sql.includes('INSERT INTO promo_sightings')) return { rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn(async () => client) } as never;
    const candidate: PromoCandidate = {
      vendor: 'Apify',
      code: 'APIFY2026',
      category: 'developer-tools',
      offerSummary: 'Apify credits',
      redeemUrl: 'javascript:alert(1)',
      sourceUrl: 'https://github.com/example/repo',
      sourceType: 'code',
      repoFullName: 'example/repo',
      confidence: 'high',
      snippet: 'Use code APIFY2026 for Apify credits.'
    };
    await upsertPromoCandidate(pool, candidate);
    const insert = calls.find(([sql]) => sql.includes('INSERT INTO promo_codes'));
    expect(insert?.[1]?.[4]).toBeNull();
    expect(insert?.[0]).toContain("NOT LIKE '%**%'");
    expect(insert?.[0]).toContain('POSITION(chr(96)');
  });
});
