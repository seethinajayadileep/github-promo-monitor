import { describe, expect, it } from 'vitest';
import {
  GitHubClient,
  SECONDARY_RATE_LIMIT_MIN_WAIT_MS,
  formatGitHubError,
  inferRateLimitResource,
  isSecondaryRateLimit,
  parseRetryAfterMs,
  secondaryRateLimitBackoffMs
} from '../src/github.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

describe('formatGitHubError', () => {
  it('includes the HTTP status, message, and first GitHub errors[].message', () => {
    expect(formatGitHubError(422, {
      message: 'Validation Failed',
      errors: [{ message: 'More than five AND / OR / NOT operators were used.' }]
    })).toBe('GitHub request failed: 422 Validation Failed: More than five AND / OR / NOT operators were used.');
  });

  it('falls back to status and message when no error detail is present', () => {
    expect(formatGitHubError(403, { message: 'Requires authentication' })).toBe('GitHub request failed: 403 Requires authentication');
    expect(formatGitHubError(500, undefined)).toBe('GitHub request failed: 500 HTTP 500');
  });
});

describe('secondary rate-limit backoff', () => {
  it('enforces a >= 60s wait and honors Retry-After when it is longer', () => {
    expect(secondaryRateLimitBackoffMs('5', { now: 0, jitterMs: 0 })).toBe(SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
    expect(secondaryRateLimitBackoffMs('90', { now: 0, jitterMs: 1000 })).toBe(91_000);
    expect(secondaryRateLimitBackoffMs('Thu, 01 Jan 1970 00:02:00 GMT', { now: 0, jitterMs: 0 })).toBe(120_000);
    expect(parseRetryAfterMs('15')).toBe(15_000);
  });

  it('detects 429 and 403 secondary/abuse limits without treating primary exhaustion as secondary', () => {
    expect(isSecondaryRateLimit(429, { remaining: 10 }, { message: 'Too many requests' }, '10')).toBe(true);
    expect(isSecondaryRateLimit(403, { remaining: 20 }, { message: 'You have exceeded a secondary rate limit' }, null)).toBe(true);
    expect(isSecondaryRateLimit(403, { remaining: 12 }, { message: 'API rate limit' }, '30')).toBe(true);
    expect(isSecondaryRateLimit(403, { remaining: 0 }, { message: 'API rate limit exceeded' }, null)).toBe(false);
    expect(isSecondaryRateLimit(403, { remaining: 5000 }, { message: 'Requires authentication' }, null)).toBe(false);
  });

  it('keeps core, search, and code-search buckets distinct', () => {
    expect(inferRateLimitResource('core-commits')).toBe('core');
    expect(inferRateLimitResource('commits-latest')).toBe('search');
    expect(inferRateLimitResource('issues')).toBe('search');
    expect(inferRateLimitResource('code')).toBe('code_search');
    expect(inferRateLimitResource('code', 'search')).toBe('search');
  });

  it('waits at least 60s with jitter on a 403 secondary rate limit, then retries', async () => {
    const waits: number[] = [];
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(403, { message: 'You have exceeded a secondary rate limit. Please wait.' }, {
          'retry-after': '12',
          'x-ratelimit-remaining': '20',
          'x-ratelimit-limit': '30',
          'x-ratelimit-resource': 'search'
        });
      }
      return jsonResponse(200, { items: [], total_count: 0 }, {
        'x-ratelimit-remaining': '19',
        'x-ratelimit-limit': '30',
        'x-ratelimit-resource': 'search'
      });
    }) as typeof fetch;
    try {
      const client = new GitHubClient({ GITHUB_TOKEN: 'test-token' }, {
        sleep: async (ms) => { waits.push(ms); }
      });
      const response = await client.request('/search/commits?q=test');
      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      expect(waits[0]).toBeGreaterThanOrEqual(SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
      expect(response.rateLimit.resource).toBe('search');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the primary reset wait for 403 remaining=0 instead of the secondary 60s backoff', async () => {
    const waits: number[] = [];
    let calls = 0;
    const reset = Math.floor(Date.now() / 1000) + 8;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(403, { message: 'API rate limit exceeded' }, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '30',
          'x-ratelimit-reset': String(reset),
          'x-ratelimit-resource': 'search'
        });
      }
      return jsonResponse(200, { items: [] }, {
        'x-ratelimit-remaining': '29',
        'x-ratelimit-limit': '30',
        'x-ratelimit-resource': 'search'
      });
    }) as typeof fetch;
    try {
      const client = new GitHubClient({ GITHUB_TOKEN: 'test-token' }, {
        sleep: async (ms) => { waits.push(ms); }
      });
      const response = await client.request('/search/issues?q=test');
      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      expect(waits[0]).toBeLessThan(SECONDARY_RATE_LIMIT_MIN_WAIT_MS);
      expect(waits[0]).toBeGreaterThanOrEqual(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('serializes concurrent requests so lanes cannot stampede one token', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return jsonResponse(200, { ok: true }, {
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-resource': 'core'
      });
    }) as typeof fetch;
    try {
      const client = new GitHubClient({ GITHUB_TOKEN: 'test-token' }, { sleep: async () => undefined });
      await Promise.all([
        client.request('/repos/acme/demo/commits?per_page=5'),
        client.request('/repos/acme/demo/commits?per_page=5'),
        client.request('/repos/acme/demo/commits?per_page=5')
      ]);
      expect(maxInFlight).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
