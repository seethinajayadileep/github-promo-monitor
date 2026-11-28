import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VendorConfig } from '@promo/shared';
import { scanFastLane, scanHistoricalBackfill, scanSlowLane, scanWatchlist } from '../src/poller.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const liveVendors = JSON.parse(fs.readFileSync(path.join(root, 'vendors.json'), 'utf8')) as VendorConfig[];

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createFakePool(cursorIndex: number) {
  const queries: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT next_index FROM scan_lane_cursors')) return { rows: [{ next_index: cursorIndex }] };
      if (sql.includes('INSERT INTO scan_lane_cursors')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT etag FROM scan_runs')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO scan_runs')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT cursor_window FROM scan_runs')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }
  };
  return { pool, queries };
}

function rateLimit(resource: string) {
  return { remaining: 100, limit: 100, resource };
}

function createGitHub(handler: (path: string) => { data?: unknown; status?: number; notModified?: boolean }) {
  const requests: string[] = [];
  const requestOptions: unknown[] = [];
  const github = {
    requests,
    requestOptions,
    request: async (path: string, options?: unknown) => {
      requests.push(path);
      requestOptions.push(options);
      const result = handler(path);
      return {
        status: result.status ?? 200,
        data: result.data,
        etag: undefined,
        notModified: result.notModified ?? false,
        rateLimit: rateLimit(path.startsWith('/search/code') ? 'code_search' : path.startsWith('/search/') ? 'search' : 'core')
      };
    },
    paceIfNeeded: async () => undefined,
    getEtag: () => undefined,
    setEtag: () => undefined
  };
  return github;
}

function commitItems(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    html_url: `https://github.com/acme/repo/commit/sha-${offset + index}`,
    sha: `sha-${offset + index}`,
    repository: { full_name: 'acme/repo' },
    commit: { message: 'routine dependency update', committer: { date: '2026-01-01T00:00:00Z' } }
  }));
}

describe('worker polling lanes', () => {
  it('resumes the fast lane at the persisted cursor, uses a live committer-date window, paginates commits, and stores processed hits', async () => {
    const { pool, queries } = createFakePool(8);
    const github = createGitHub((path) => {
      if (path.startsWith('/search/commits')) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
        return { data: { total_count: 32, items: commitItems(page === 1 ? 30 : 2, page === 1 ? 0 : 30) } };
      }
      if (path.startsWith('/search/issues')) return { data: { total_count: 0, items: [] } };
      return { data: {} };
    });

    await scanFastLane({ pool: pool as never, github: github as never, vendors: liveVendors, watchlist: [] });

    const commitRequests = github.requests.filter((path) => path.startsWith('/search/commits'));
    expect(commitRequests).toHaveLength(2);
    expect(commitRequests[0]).toContain('committer-date%3A');
    expect(commitRequests[0]).toContain('page=1');
    expect(commitRequests[1]).toContain('page=2');
    expect(github.requests.some((path) => path.startsWith('/search/issues'))).toBe(true);
    expect(github.requests.filter((path) => path.startsWith('/repos/acme/repo/commits/sha-'))).toHaveLength(30);

    const commitRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[0] === 'fast:8' && String(params[1]).startsWith('commits-'));
    expect(commitRun?.params?.[5]).toBe(32);
    const cursorWrite = queries.find(({ sql }) => sql.includes('INSERT INTO scan_lane_cursors'));
    expect(cursorWrite?.params).toEqual(['fast', 9]);
  });

  it('resumes slow lane tail vendors, paginates code search, passes indexed refs, and stores processed hits', async () => {
    const { pool, queries } = createFakePool(125);
    const github = createGitHub((path) => {
      if (path.startsWith('/search/code')) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
        const count = page === 1 ? 30 : 1;
        const offset = page === 1 ? 0 : 30;
        return {
          data: {
            total_count: 31,
            items: Array.from({ length: count }, (_, index) => ({
              html_url: `https://github.com/acme/repo/blob/main/README.md#L${offset + index}`,
              path: 'README.md',
              sha: `indexedsha${offset + index}`,
              repository: { full_name: 'acme/repo' },
              text_matches: [{ fragment: 'ordinary documentation' }]
            }))
          }
        };
      }
      if (path.startsWith('/repos/acme/repo/contents/')) {
        return { data: { content: Buffer.from('ordinary documentation').toString('base64'), encoding: 'base64' } };
      }
      return { data: {} };
    });

    await scanSlowLane({ pool: pool as never, github: github as never, vendors: liveVendors, watchlist: [] });

    const codeRequests = github.requests.filter((path) => path.startsWith('/search/code'));
    expect(codeRequests).toHaveLength(2);
    expect(codeRequests[0]).toContain('page=1');
    expect(codeRequests[1]).toContain('page=2');
    expect(github.requests.some((path) => path.includes('README.md?ref=indexedsha0'))).toBe(true);
    expect(github.requests.filter((path) => path.startsWith('/repos/acme/repo/contents/README.md'))).toHaveLength(8);

    const codeRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[0] === 'slow:125');
    expect(codeRun?.params?.[5]).toBe(31);
    const cursorWrite = queries.find(({ sql }) => sql.includes('INSERT INTO scan_lane_cursors'));
    expect(cursorWrite?.params).toEqual(['slow', 126]);
  });

  it('fetches 20 watchlist commits and inspects their diffs', async () => {
    const { pool } = createFakePool(0);
    const github = createGitHub((path) => {
      if (path.startsWith('/repos/acme/repo/commits?')) {
        return {
          data: Array.from({ length: 20 }, (_, index) => ({
            sha: `watchsha${index}`,
            html_url: `https://github.com/acme/repo/commit/watchsha${index}`,
            commit: { message: 'routine docs update', committer: { date: '2026-01-01T00:00:00Z' } }
          }))
        };
      }
      if (path.startsWith('/repos/acme/repo/commits/watchsha')) {
        return { data: { commit: { message: 'routine docs update' }, files: [{ filename: 'README.md', patch: 'ordinary documentation' }] } };
      }
      return { data: {} };
    });

    await scanWatchlist({ pool: pool as never, github: github as never, vendors: liveVendors, watchlist: [{ repo: 'acme/repo' }] });

    expect(github.requests[0]).toContain('/repos/acme/repo/commits?per_page=20');
    expect(github.requests.filter((path) => path.startsWith('/repos/acme/repo/commits/watchsha'))).toHaveLength(20);
  });

  it('does not mark a backfill window complete when capped commit pages leave results unscanned', async () => {
    const { pool, queries } = createFakePool(0);
    const github = createGitHub((path) => {
      if (path.startsWith('/search/commits')) return { data: { total_count: 1000, items: commitItems(30) } };
      return { data: {} };
    });
    const oneVendor: VendorConfig[] = [{ id: 'openai', name: 'OpenAI', category: 'ai', domains: ['openai.com'], keywords: ['OpenAI'] }];

    await scanHistoricalBackfill({ pool: pool as never, github: github as never, vendors: oneVendor, watchlist: [] });

    const completionRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[0] === 'backfill-window-complete');
    expect(completionRun).toBeUndefined();
    const commitWindows = new Set(github.requests.filter((path) => path.startsWith('/search/commits')).map((path) => decodeURIComponent(path).match(/committer-date:[^\s&]+/)?.[0]));
    expect(commitWindows.size).toBeGreaterThan(1);
    const commitRequestOptions = github.requests
      .map((path, index) => ({ path, options: github.requestOptions[index] as { cacheKey?: string } | undefined }))
      .filter(({ path }) => path.startsWith('/search/commits'));
    expect(commitRequestOptions.every(({ options }) => options?.cacheKey === undefined)).toBe(true);
  });
});
