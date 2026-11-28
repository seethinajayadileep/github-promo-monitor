import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VendorConfig } from '@promo/shared';
import { config } from '../src/config.js';
import { scanFastLane, scanHistoricalBackfill, scanSlowLane, scanWatchlist } from '../src/poller.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const liveVendors = JSON.parse(fs.readFileSync(path.join(root, 'vendors.json'), 'utf8')) as VendorConfig[];

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createFakePool(cursorIndex: number, followed: string[] = []) {
  const queries: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT next_index FROM scan_lane_cursors')) return { rows: [{ next_index: cursorIndex }] };
      if (sql.includes('INSERT INTO scan_lane_cursors')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT etag FROM scan_runs')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO scan_runs')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT cursor_window FROM scan_runs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM promo_codes') && sql.includes('followed_repos')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM followed_repos')) {
        const exclude = Array.isArray(params?.[1]) ? params[1] as string[] : [];
        const rows = followed
          .filter((repo) => !exclude.includes(repo))
          .map((repoFullName) => ({ repo_full_name: repoFullName }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('UPDATE followed_repos') || sql.includes('INSERT INTO followed_repos')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('INSERT INTO promo_codes')) return { rows: [{ id: 1, inserted: true }] };
        if (sql.includes('INSERT INTO promo_sightings')) return { rowCount: 1 };
        if (sql.includes('UPDATE promo_codes')) return { rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    })
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
        const pageSize = config.searchPageSize;
        return { data: { total_count: pageSize + 2, items: commitItems(page === 1 ? pageSize : 2, page === 1 ? 0 : pageSize) } };
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
    expect(github.requests.filter((path) => path.startsWith('/repos/acme/repo/commits/sha-'))).toHaveLength(
      Math.min(config.searchPageSize + 2, config.maxCommitDetailsPerScan)
    );

    const commitRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[0] === 'fast:8' && String(params[1]).startsWith('commits-'));
    expect(commitRun?.params?.[5]).toBe(config.searchPageSize + 2);
    const cursorWrite = queries.find(({ sql }) => sql.includes('INSERT INTO scan_lane_cursors'));
    expect(cursorWrite?.params).toEqual(['fast', 9]);
  });

  it('resumes slow lane tail vendors, paginates code search, passes indexed refs, and stores processed hits', async () => {
    const { pool, queries } = createFakePool(125);
    const github = createGitHub((path) => {
      if (path.startsWith('/search/code')) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
        const pageSize = config.searchPageSize;
        const count = page === 1 ? pageSize : 1;
        const offset = page === 1 ? 0 : pageSize;
        return {
          data: {
            total_count: config.searchPageSize + 1,
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
    expect(github.requests.filter((path) => path.startsWith('/repos/acme/repo/contents/README.md'))).toHaveLength(
      Math.min(config.searchPageSize + 1, config.maxCodeFilesPerScan)
    );

    const codeRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[0] === 'slow:125');
    expect(codeRun?.params?.[5]).toBe(config.searchPageSize + 1);
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
      if (path.startsWith('/search/commits')) return { data: { total_count: 1000, items: commitItems(config.searchPageSize) } };
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

  it('paginates issue search until a short page and stores every fetched hit', async () => {
    const { pool, queries } = createFakePool(0);
    const pageSize = config.searchPageSize;
    const github = createGitHub((path) => {
      if (path.startsWith('/search/commits')) return { data: { total_count: 0, items: [] } };
      if (path.startsWith('/search/issues')) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
        const count = page === 1 ? pageSize : 3;
        const offset = page === 1 ? 0 : pageSize;
        return {
          data: {
            total_count: pageSize + 3,
            items: Array.from({ length: count }, (_, index) => ({
              html_url: `https://github.com/acme/repo/issues/${offset + index}`,
              title: 'ordinary question',
              body: 'no promo here',
              repository_url: 'https://api.github.com/repos/acme/repo'
            }))
          }
        };
      }
      return { data: {} };
    });

    await scanFastLane({ pool: pool as never, github: github as never, vendors: liveVendors, watchlist: [] });

    const issueRequests = github.requests.filter((path) => path.startsWith('/search/issues'));
    expect(issueRequests).toHaveLength(2);
    expect(issueRequests[0]).toContain('page=1');
    expect(issueRequests[1]).toContain('page=2');
    expect(issueRequests[0]).toContain(`per_page=${pageSize}`);
    const issueRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[1] === 'issues');
    expect(issueRun?.params?.[5]).toBe(pageSize + 3);
  });

  it('keeps code hits already fetched when a later page is rate limited', async () => {
    const { pool, queries } = createFakePool(0);
    const github = createGitHub((path) => {
      if (path.startsWith('/search/code')) {
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
        if (page > 1) throw new Error('GitHub request failed: 429 Too many requests');
        return {
          data: {
            total_count: 1000,
            items: Array.from({ length: config.searchPageSize }, (_, index) => ({
              html_url: `https://github.com/acme/repo/blob/main/README.md#L${index}`,
              path: 'README.md',
              sha: `limitedsha${index}`,
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

    expect(github.requests.filter((path) => path.startsWith('/search/code'))).toHaveLength(2);
    expect(github.requests.filter((path) => path.startsWith('/repos/acme/repo/contents/'))).toHaveLength(config.maxCodeFilesPerScan);
    const codeRun = queries.find(({ sql, params }) => sql.includes('INSERT INTO scan_runs') && params?.[1] === 'code');
    expect(codeRun?.params?.[5]).toBe(config.searchPageSize);
    expect(codeRun?.params?.[10]).toBe(1);
    expect(codeRun?.params?.[12]).toBe(false);
    expect(codeRun?.params?.[13]).toBe(true);
    expect(codeRun?.params?.[15]).toBe('slow');
  });

  it('polls repos that already yielded promos and stores a later public code from a new push', async () => {
    const { pool, queries } = createFakePool(0, ['acme/repo', 'acme/promo-notes']);
    const github = createGitHub((path) => {
      if (path.startsWith('/repos/acme/repo/commits?')) return { data: [] };
      if (path.startsWith('/repos/acme/promo-notes/commits?')) {
        return {
          data: [{
            sha: 'newsha',
            html_url: 'https://github.com/acme/promo-notes/commit/newsha',
            commit: {
              message: 'Use promo code HACK2026 for OpenAI credits https://platform.openai.com',
              committer: { date: '2026-11-28T00:00:00Z' }
            }
          }]
        };
      }
      if (path.startsWith('/repos/acme/promo-notes/commits/newsha')) {
        return {
          data: {
            commit: { message: 'Use promo code HACK2026 for OpenAI credits https://platform.openai.com' },
            files: [{ filename: 'README.md', patch: 'Use promo code HACK2026 for OpenAI credits at https://platform.openai.com' }]
          }
        };
      }
      return { data: {} };
    });

    await scanWatchlist({
      pool: pool as never,
      github: github as never,
      vendors: liveVendors,
      watchlist: [{ repo: 'acme/repo' }]
    });

    const lists = github.requests.filter((path) => path.includes('/commits?'));
    expect(lists.filter((path) => path.includes('/repos/acme/repo/commits?'))).toHaveLength(1);
    expect(lists.find((path) => path.includes('/repos/acme/repo/'))).toContain('per_page=20');
    expect(lists.some((path) => path.includes(`/repos/acme/promo-notes/commits?per_page=${config.followedRepoCommitPageSize}`))).toBe(true);
    const listQuery = queries.find(({ sql }) => sql.includes('FROM followed_repos') && sql.includes('SELECT repo_full_name'));
    expect(listQuery?.params?.[1]).toEqual(['acme/repo']);
    expect(queries.some(({ sql, params }) => sql.includes('INSERT INTO promo_codes') && params?.includes('HACK2026'))).toBe(true);
    expect(queries.some(({ sql, params }) => sql.includes('INSERT INTO followed_repos') && !sql.includes('SELECT') && params?.[0] === 'acme/promo-notes')).toBe(true);
    expect(queries.filter(({ sql }) => sql.includes('UPDATE followed_repos')).map(({ params }) => params?.[0])).toEqual(['acme/promo-notes']);
  });
});
