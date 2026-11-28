import { describe, expect, it, vi } from 'vitest';
import type { VendorConfig } from '@promo/shared';
import { scanExaLane } from '../src/exaLane.js';

const vendor: VendorConfig = {
  id: 'openai',
  name: 'OpenAI',
  category: 'ai',
  domains: ['openai.com'],
  keywords: ['OpenAI']
};

function createPool() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    queries,
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT next_index')) return { rows: [{ next_index: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('INSERT INTO promo_codes')) return { rows: [{ id: 1, inserted: true }] };
        if (sql.includes('INSERT INTO promo_sightings')) return { rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    })
  };
  return pool;
}

describe('exa discovery lane', () => {
  it('does not call Exa when the key is missing', async () => {
    delete process.env.EXA_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pool = createPool();
    await scanExaLane({ pool: pool as never, github: {} as never, vendors: [vendor], watchlist: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.queries.some((query) => query.sql.includes('INSERT INTO exa_searches'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('searches one vendor on github.com and drops other hosts before Pass-1', async () => {
    process.env.EXA_API_KEY = 'exa-test-key';
    process.env.EXA_SEARCH_TYPE = 'auto';
    process.env.EXA_NUM_RESULTS = '10';
    delete process.env.OPENAI_API_KEY;
    delete process.env.SARVAM_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('exa-test-key');
      expect(JSON.stringify(init?.body)).not.toContain('exa-test-key');
      return new Response(JSON.stringify({
        results: [
          {
            url: 'https://github.com/acme/promo/blob/main/README.md',
            title: 'OpenAI credits',
            highlights: ['Use promo code HACK2026 for OpenAI credits at https://platform.openai.com']
          },
          {
            url: 'https://www.retailmenot.com/view/openai',
            title: 'coupon dump',
            highlights: ['Use promo code HACK2026 for OpenAI credits']
          }
        ],
        costDollars: { total: 0.007 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const pool = createPool();
    await scanExaLane({ pool: pool as never, github: {} as never, vendors: [vendor], watchlist: [] });
    const body = bodies[0] as { includeDomains?: string[]; numResults?: number; page?: number; category?: string };
    expect(body.includeDomains).toEqual(['github.com']);
    expect(body.numResults).toBe(10);
    expect(body.page).toBeUndefined();
    expect(body.category).toBeUndefined();
    const exaInsert = pool.queries.find((query) => query.sql.includes('INSERT INTO exa_searches'));
    expect(exaInsert?.params?.[2]).toBe('ok');
    expect(exaInsert?.params?.[9]).toBe(2);
    expect(exaInsert?.params?.[10]).toBe(1);
    expect(exaInsert?.params?.[11]).toBe(1);
    expect(pool.queries.some((query) => query.sql.includes('INSERT INTO promo_codes') && query.params?.includes('HACK2026'))).toBe(true);
    expect(JSON.stringify(pool.queries)).not.toContain('exa-test-key');
    expect(JSON.stringify(pool.queries)).not.toContain('retailmenot');
    vi.unstubAllGlobals();
    delete process.env.EXA_API_KEY;
  });

  it('records an http status without the response body when Exa rejects the request', async () => {
    process.env.EXA_API_KEY = 'exa-test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'key exa-test-key leaked' }), { status: 429 })));
    const pool = createPool();
    await scanExaLane({ pool: pool as never, github: {} as never, vendors: [vendor], watchlist: [] });
    const exaInsert = pool.queries.find((query) => query.sql.includes('INSERT INTO exa_searches'));
    expect(exaInsert?.params?.[2]).toBe('error');
    expect(exaInsert?.params?.[3]).toBe('http-429');
    expect(JSON.stringify(exaInsert?.params)).not.toContain('exa-test-key');
    expect(JSON.stringify(exaInsert?.params)).not.toContain('leaked');
    vi.unstubAllGlobals();
    delete process.env.EXA_API_KEY;
  });
});
