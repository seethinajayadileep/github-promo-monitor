import { describe, expect, it } from 'vitest';
import { countBackfillWindowsRemaining, previousBackfillWindow } from '../src/backfillWindow.js';
import {
  buildExaSearchBody,
  estimateExaListPrice,
  exaSearchRequest,
  isGithubWebUrl,
  parseExaHits,
  publicExaSettings,
  repoFromGithubUrl,
  resolveExaCost,
  sourceTypeFromGithubUrl
} from '../src/exaSearch.js';
import { istDateString, istDayStart, shiftIstDate } from '../src/ist.js';
import { classifyLlmFailure, estimateLlmCostUsd, parseProviderUsage } from '../src/llmUsage.js';
import { estimateQueryCycle, searchPageCapSaturated, STATS_HONESTY, unopenedSearchHits } from '../src/scanMeta.js';
import { normalizeStatsFilters } from '../src/statsFilters.js';
import { loadDashboardStats } from '../src/stats.js';
import { sanitizePublicWorkerConfig } from '../src/workerPublicConfig.js';

describe('llm usage records', () => {
  it('parses OpenAI usage and prices gpt-6-luna without keeping prompt text', () => {
    const usage = parseProviderUsage({
      choices: [{ finish_reason: 'stop', message: { content: 'secret-looking body' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } }
    });
    expect(usage).toEqual({ promptTokens: 1000, completionTokens: 500, cachedTokens: 200, finishReason: 'stop' });
    expect(JSON.stringify(usage)).not.toContain('secret-looking');
    expect(estimateLlmCostUsd('gpt-6-luna', usage)).toEqual({
      usd: 0.00035,
      priced: true,
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      cachedPerMillion: 0.1
    });
    expect(estimateLlmCostUsd('sarvam-105b', usage).priced).toBe(false);
  });

  it('classifies failures without keeping response bodies or keys', () => {
    expect(classifyLlmFailure('http-500: bearer sk-abcdef secret').code).toBe('http-500');
    expect(classifyLlmFailure('The operation was aborted due to timeout').code).toBe('timeout');
    expect(classifyLlmFailure('finish-length-truncated-output')).toEqual({ status: 'error', code: 'finish-length-truncated-output' });
    expect(JSON.stringify(classifyLlmFailure('http-401: sk-live-key'))).not.toContain('sk-');
  });
});

describe('honest scan progress', () => {
  it('counts backfill calendar windows instead of a GitHub total', () => {
    expect(previousBackfillWindow('2026-11-22..2026-11-28', 7, new Date('2026-11-28T00:00:00Z')).end).toBe('2026-11-21');
    const progress = countBackfillWindowsRemaining({
      lastCompletedWindow: '2026-11-22..2026-11-28',
      daysPerWindow: 7,
      stopDate: '2026-11-20',
      now: new Date('2026-11-28T00:00:00Z')
    });
    expect(progress.windowsRemaining).toBe(1);
    expect(progress.nextWindow).toEqual({ start: '2026-11-15', end: '2026-11-21' });
    expect(progress.reachedStop).toBe(false);
  });

  it('does not treat a search total above 1000 as fetchable hits', () => {
    expect(searchPageCapSaturated({
      hitsFetched: 1000,
      reportedTotal: 5000,
      pageFailed: false
    })).toBe(true);
    expect(searchPageCapSaturated({
      hitsFetched: 40,
      reportedTotal: 40,
      pageFailed: false
    })).toBe(false);
    expect(unopenedSearchHits({ hitsFetched: 100, reportedTotal: 5000, capSaturated: true, rateLimited: false })).toEqual({ hits: 900, reason: 'cap' });
    expect(unopenedSearchHits({ hitsFetched: 100, reportedTotal: 5000, capSaturated: false, rateLimited: false }).hits).toBeNull();
  });

  it('estimates a vendor-query cycle from the cursor and interval', () => {
    const cycle = estimateQueryCycle({ queryCount: 10, nextIndex: 3, intervalMs: 90_000, observedGapsMs: [80_000, 90_000, 100_000] });
    expect(cycle.nextQueryNumber).toBe(4);
    expect(cycle.queriesUntilWrap).toBe(7);
    expect(cycle.nominalCycleMs).toBe(900_000);
    expect(cycle.basis).toBe('observed-gap');
    expect(cycle.estimatedFullCycleMs).toBe(900_000);
  });

  it('states that GitHub search is not a finite repo queue', () => {
    expect(STATS_HONESTY.notAQueue).toContain('not a finite queue');
    expect(STATS_HONESTY.historicalTokens).toContain('zero');
  });
});

describe('stats filters', () => {
  it('uses an inclusive IST date range and drops unsafe model text', () => {
    const filters = normalizeStatsFilters({ from: '2026-11-28', to: '2026-11-28', model: 'gpt-6-luna', lane: 'slow', q: 'vendor' }, new Date('2026-11-28T12:00:00Z'));
    expect(filters.start.toISOString()).toBe(istDayStart('2026-11-28').toISOString());
    expect(filters.end.toISOString()).toBe(istDayStart(shiftIstDate('2026-11-28', 1)).toISOString());
    expect(istDateString(new Date('2026-11-27T18:30:00Z'))).toBe('2026-11-28');
    expect(normalizeStatsFilters({ model: 'sk-secret' }).model).toBe('');
    expect(normalizeStatsFilters({ lane: 'github' }).lane).toBe('');
    expect(normalizeStatsFilters({ lane: 'exa' }).lane).toBe('exa');
  });
});

describe('scan hit sums above a 32-bit integer', () => {
  it('does not throw and keeps inflated totals out of hits opened', async () => {
    const inflated = 2_356_384_782;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('stats-lane-summary') || sql.includes('stats-surfaces')) {
          const casts = sql.match(/SUM\(hits_found\)[\s\S]{0,180}?::(?:int|bigint)/gi) ?? [];
          if (casts.length === 0 || casts.some((part) => /::int\b/i.test(part))) {
            const error = new Error('integer out of range') as Error & { code?: string };
            error.code = '22003';
            throw error;
          }
        }
        if (sql.includes('stats-lane-summary')) {
          return {
            rows: [{
              lane: 'fast',
              runs: '6982',
              hits_found: '120',
              legacy_hits: String(inflated),
              legacy_runs: '4100',
              new_codes: '3',
              pages_scanned: '10',
              cap_hits: '0',
              rate_limited_runs: '0',
              runs_missing_page_detail: '4100',
              last_scan_at: '2026-11-28T00:00:00.000Z'
            }]
          };
        }
        if (sql.includes('stats-surfaces')) {
          return {
            rows: [{
              lane: 'fast',
              surface: 'commits',
              runs: '6982',
              hits_found: '80',
              legacy_hits: String(inflated),
              legacy_runs: '4100',
              new_codes: '1',
              last_scan_at: '2026-11-28T00:00:00.000Z'
            }]
          };
        }
        return { rows: [] };
      }
    };
    const stats = await loadDashboardStats(pool as never, normalizeStatsFilters({}, new Date('2026-11-28T12:00:00Z')), {
      now: new Date('2026-11-28T12:00:00Z'),
      searchQueryCount: 12,
      codeQueryCount: 4,
      watchlistRepos: [],
      filesLoaded: true
    });
    const fast = stats.lanes.find((lane) => lane.lane === 'fast');
    expect(fast?.hitsFound).toBe(120);
    expect(fast?.legacyHits).toBe(inflated);
    expect(fast?.legacyHits).toBeGreaterThan(2_147_483_647);
    expect(stats.surfaces[0]?.hitsFound).toBe(80);
    expect(stats.surfaces[0]?.legacyHits).toBe(inflated);
    expect(stats.notes.join(' ')).toContain('1,000');
  });
});

describe('worker config sanitizer', () => {
  it('drops secrets and unknown keys', () => {
    const clean = sanitizePublicWorkerConfig({
      fastLaneIntervalMs: 90000,
      exaConfigured: true,
      exaSearchType: 'auto',
      llmModel: 'gpt-6-luna',
      GITHUB_TOKEN: 'ghp_shouldnotleak',
      EXA_API_KEY: 'exa-secret',
      backfillStopDate: '2020-01-01'
    });
    const json = JSON.stringify(clean);
    expect(json).not.toContain('ghp_');
    expect(json).not.toContain('exa-secret');
    expect(clean.exaConfigured).toBe(true);
    expect(clean.exaSearchType).toBe('auto');
    expect(clean.fastLaneIntervalMs).toBe(90000);
  });
});

describe('exa search requests', () => {
  it('stays on github.com, does not paginate, and omits maxAgeHours for lite', () => {
    const auto = publicExaSettings({ EXA_API_KEY: 'exa-test-key', EXA_SEARCH_TYPE: 'auto', EXA_NUM_RESULTS: '250' });
    const body = buildExaSearchBody('Public GitHub promo for OpenAI', auto);
    expect(body.includeDomains).toEqual(['github.com']);
    expect(body.numResults).toBe(100);
    expect(body).not.toHaveProperty('category');
    expect(body).not.toHaveProperty('page');
    expect(body.contents).toMatchObject({ highlights: true, maxAgeHours: 24 });
    expect(JSON.stringify(body)).not.toContain('exa-test-key');

    const lite = publicExaSettings({ EXA_API_KEY: 'exa-test-key', EXA_SEARCH_TYPE: 'lite', EXA_MAX_AGE_HOURS: '1' });
    const liteBody = buildExaSearchBody('query', lite);
    expect(liteBody.contents).toEqual({ highlights: true });
    const request = exaSearchRequest('query', 'exa-test-key', lite);
    expect(request.headers['x-api-key']).toBe('exa-test-key');
    expect(JSON.stringify(request.body)).not.toContain('exa-test-key');
  });

  it('keeps only github.com results and prices auto search at the published rate', () => {
    expect(isGithubWebUrl('https://github.com/acme/repo/blob/main/README.md')).toBe(true);
    expect(isGithubWebUrl('https://example.com/coupons')).toBe(false);
    expect(repoFromGithubUrl('https://github.com/acme/repo/commit/abc')).toBe('acme/repo');
    expect(sourceTypeFromGithubUrl('https://github.com/acme/repo/commit/abc')).toBe('commit');
    const hits = parseExaHits({
      results: [
        { url: 'https://github.com/acme/repo', title: 'Promo', highlights: ['use code HACK2026'] },
        { url: 'https://news.ycombinator.com/item?id=1', title: 'elsewhere', highlights: ['coupon'] }
      ],
      costDollars: { total: 0.007 }
    });
    expect(hits).toHaveLength(2);
    expect(estimateExaListPrice('auto', 10)).toEqual({ usd: 0.007, priced: true });
    expect(estimateExaListPrice('lite', 12).usd).toBe(0.006);
    expect(estimateExaListPrice('deep-lite', 10).priced).toBe(false);
    expect(resolveExaCost('auto', 10, { costDollars: { total: 0.009 } })).toEqual({ usd: 0.009, source: 'response' });
    expect(resolveExaCost('deep-lite', 10, {}).source).toBeNull();
  });

  it('keeps the lane interval at least as long as the fast GitHub lane', () => {
    const settings = publicExaSettings({ EXA_API_KEY: 'present', EXA_INTERVAL_MS: '1000', FAST_LANE_INTERVAL_MS: '90000' });
    expect(settings.configured).toBe(true);
    expect(settings.intervalMs).toBe(90_000);
    expect(publicExaSettings({}).configured).toBe(false);
  });
});

describe('stats loader', () => {
  it('returns zeros and the honesty notes when telemetry tables are absent', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const stats = await loadDashboardStats(pool as never, normalizeStatsFilters({}, new Date('2026-11-28T12:00:00Z')), {
      now: new Date('2026-11-28T12:00:00Z'),
      searchQueryCount: 12,
      codeQueryCount: 192,
      watchlistRepos: ['acme/repo'],
      filesLoaded: true
    });
    expect(stats.tokens.requests).toBe(0);
    expect(stats.exa.configured).toBeNull();
    expect(stats.exa.requests).toBe(0);
    expect(stats.honesty.notAQueue).toContain('not a finite queue');
    expect(stats.remaining.backfill.windowsRemaining).toBeNull();
    expect(JSON.stringify(stats)).not.toMatch(/sk-|ghp_|EXA_API_KEY/);
  });
});
