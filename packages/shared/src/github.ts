export interface RateLimitState {
  remaining?: number;
  reset?: number;
  limit?: number;
  resource?: string;
  retryAfter?: string | null;
}

export interface GitHubResponse<T> {
  status: number;
  data?: T;
  etag?: string;
  notModified: boolean;
  rateLimit: RateLimitState;
}

interface CacheEntry {
  etag?: string;
}

export type SleepFn = (ms: number) => Promise<void>;

const SECONDARY_RATE_LIMIT_MESSAGE = /secondary rate limit|abuse detection|too many requests/i;
const SEARCH_MIN_GAP_MS = 1_200;
export const SECONDARY_RATE_LIMIT_MIN_WAIT_MS = 60_000;
export const SECONDARY_RATE_LIMIT_MAX_RETRIES = 2;
const SECONDARY_RATE_LIMIT_MAX_JITTER_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitHubTokenPool {
  private readonly tokens: string[];
  private index = 0;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.tokens = [
      ...(env.GITHUB_TOKEN ? [env.GITHUB_TOKEN] : []),
      ...(env.GITHUB_TOKENS ?? '').split(',').map((token) => token.trim()).filter(Boolean)
    ].filter((token, position, all) => all.indexOf(token) === position);
  }

  get size(): number {
    return this.tokens.length;
  }

  current(): string | undefined {
    return this.tokens[this.index % Math.max(1, this.tokens.length)];
  }

  rotate(): string | undefined {
    if (!this.tokens.length) return undefined;
    this.index = (this.index + 1) % this.tokens.length;
    return this.current();
  }
}

export function parseRetryAfterMs(retryAfter: string | null | undefined, now = Date.now()): number | undefined {
  if (!retryAfter) return undefined;
  const trimmed = retryAfter.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

export function secondaryRateLimitBackoffMs(
  retryAfter: string | null | undefined,
  options: { now?: number; jitterMs?: number } = {}
): number {
  const now = options.now ?? Date.now();
  const jitterMs = options.jitterMs ?? Math.floor(Math.random() * (SECONDARY_RATE_LIMIT_MAX_JITTER_MS + 1));
  const retryAfterMs = parseRetryAfterMs(retryAfter, now) ?? 0;
  return Math.max(SECONDARY_RATE_LIMIT_MIN_WAIT_MS, retryAfterMs) + Math.max(0, jitterMs);
}

export function isSecondaryRateLimit(status: number, rateLimit: RateLimitState, data: unknown, retryAfter?: string | null): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (rateLimit.remaining === 0) return false;
  if (retryAfter ?? rateLimit.retryAfter) return true;
  return SECONDARY_RATE_LIMIT_MESSAGE.test(githubErrorMessage(data, status));
}

export function rateLimitResourceFromPath(path: string, headerResource?: string): string | undefined {
  if (headerResource) return headerResource;
  if (path.startsWith('/search/code')) return 'code_search';
  if (path.startsWith('/search/')) return 'search';
  return 'core';
}

export function inferRateLimitResource(surface: string, stored?: string | null): string {
  if (stored) return stored;
  if (surface === 'code') return 'code_search';
  if (surface === 'issues' || surface.startsWith('commits-')) return 'search';
  if (surface === 'core-commits') return 'core';
  return 'unknown';
}

function githubErrorMessage(data: unknown, status: number): string {
  const payload = data && typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined;
  return payload && payload.message != null ? String(payload.message) : `HTTP ${status}`;
}

export class GitHubClient {
  readonly tokenPool: GitHubTokenPool;
  private readonly etagCache = new Map<string, CacheEntry>();
  private readonly userAgent = 'public-promo-monitor/1.0';
  private readonly sleepFn: SleepFn;
  private requestTail: Promise<void> = Promise.resolve();
  private lastSearchAt = 0;

  constructor(env: NodeJS.ProcessEnv = process.env, options: { sleep?: SleepFn } = {}) {
    this.tokenPool = new GitHubTokenPool(env);
    this.sleepFn = options.sleep ?? sleep;
  }

  getEtag(cacheKey: string): string | undefined {
    return this.etagCache.get(cacheKey)?.etag;
  }

  setEtag(cacheKey: string, etag: string): void {
    this.etagCache.set(cacheKey, { etag });
  }

  async request<T>(path: string, options: { cacheKey?: string; accept?: string; method?: string; body?: unknown; retryOnRateLimit?: boolean } = {}): Promise<GitHubResponse<T>> {
    return this.withLock(() => this.requestUnlocked<T>(path, options));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.requestTail;
    let release!: () => void;
    this.requestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async requestUnlocked<T>(
    path: string,
    options: { cacheKey?: string; accept?: string; method?: string; body?: unknown; retryOnRateLimit?: boolean },
    attempt = 0
  ): Promise<GitHubResponse<T>> {
    const retryOnRateLimit = options.retryOnRateLimit ?? true;
    if (path.startsWith('/search/')) {
      const wait = this.lastSearchAt + SEARCH_MIN_GAP_MS - Date.now();
      if (wait > 0) await this.sleepFn(wait);
    }

    const token = this.tokenPool.current();
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'user-agent': this.userAgent,
      'x-github-api-version': '2022-11-28'
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const cachedEtag = options.cacheKey ? this.etagCache.get(options.cacheKey)?.etag : undefined;
    if (cachedEtag) headers['if-none-match'] = cachedEtag;

    const response = await fetch(`https://api.github.com${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(Number(process.env.GITHUB_REQUEST_TIMEOUT_MS ?? 20_000))
    });
    if (path.startsWith('/search/')) this.lastSearchAt = Date.now();

    const retryAfter = response.headers.get('retry-after');
    const rateLimit: RateLimitState = {
      remaining: numberHeader(response.headers.get('x-ratelimit-remaining')),
      reset: numberHeader(response.headers.get('x-ratelimit-reset')),
      limit: numberHeader(response.headers.get('x-ratelimit-limit')),
      resource: rateLimitResourceFromPath(path, response.headers.get('x-ratelimit-resource') ?? undefined),
      retryAfter
    };
    const etag = response.headers.get('etag') ?? undefined;
    if (options.cacheKey && etag) this.etagCache.set(options.cacheKey, { etag });
    if (response.status === 304) return { status: response.status, notModified: true, etag, rateLimit };

    const text = await response.text();
    const data = text ? JSON.parse(text) as T : undefined;

    if (response.status === 403 && rateLimit.remaining === 0 && retryOnRateLimit) {
      if (this.tokenPool.size > 1) this.tokenPool.rotate();
      else await this.waitForRateLimit(rateLimit);
      return this.requestUnlocked<T>(path, { ...options, retryOnRateLimit: false }, attempt);
    }

    if (isSecondaryRateLimit(response.status, rateLimit, data, retryAfter) && attempt < SECONDARY_RATE_LIMIT_MAX_RETRIES) {
      const waitMs = secondaryRateLimitBackoffMs(retryAfter);
      console.log(JSON.stringify({
        event: 'github_secondary_rate_limit',
        at: new Date().toISOString(),
        status: response.status,
        resource: rateLimit.resource,
        waitMs,
        attempt: attempt + 1
      }));
      await this.sleepFn(waitMs);
      return this.requestUnlocked<T>(path, options, attempt + 1);
    }

    if (!response.ok && response.status !== 304) {
      throw new Error(formatGitHubError(response.status, data));
    }
    return { status: response.status, data, etag, notModified: false, rateLimit };
  }

  async waitForRateLimit(rateLimit: RateLimitState): Promise<void> {
    if (rateLimit.remaining !== 0 || !rateLimit.reset) return;
    const waitMs = Math.max(1000, rateLimit.reset * 1000 - Date.now() + 1000);
    await this.sleepFn(Math.min(waitMs, 15 * 60 * 1000));
  }

  async paceIfNeeded(rateLimit: RateLimitState, minimumPercent: number): Promise<void> {
    if (rateLimit.remaining === undefined || rateLimit.limit === undefined || rateLimit.limit === 0) return;
    const percentRemaining = (rateLimit.remaining / rateLimit.limit) * 100;
    if (percentRemaining >= minimumPercent) return;
    if (this.tokenPool.size > 1) {
      this.tokenPool.rotate();
      return;
    }
    await this.waitForRateLimit({ remaining: 0, reset: rateLimit.reset });
  }
}

export function formatGitHubError(status: number, data: unknown): string {
  const payload = data && typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined;
  const message = payload && payload.message != null ? String(payload.message) : `HTTP ${status}`;
  const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors[0] && typeof errors[0] === 'object' && errors[0] !== null && 'message' in errors[0]
    ? String((errors[0] as { message?: unknown }).message)
    : undefined;
  if (first && first.trim()) return `GitHub request failed: ${status} ${message}: ${first}`;
  return `GitHub request failed: ${status} ${message}`;
}

function numberHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function encodeQuery(query: string): string {
  return encodeURIComponent(query.replace(/\s+/g, ' ').trim());
}
