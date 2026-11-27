import { describe, expect, it, vi } from 'vitest';
import { advanceLaneCursor, getLaneCursor, pruneScanRuns, upsertPromoCandidate } from '../src/db.js';
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
