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

interface GitHubRequestOptions {
  cacheKey?: string;
  accept?: string;
  method?: string;
  body?: unknown;
  retryOnRateLimit?: boolean;
}

interface PerformedRequest<T> {
  response?: GitHubResponse<T>;
  primaryRateLimit?: RateLimitState;
  secondaryRateLimit?: {
    status: number;
    rateLimit: RateLimitState;
    retryAfter?: string | null;
    error: Error;
  };
  error?: Error;
}

export class GitHubClient {
  readonly tokenPool: GitHubTokenPool;
  private readonly etagCache = new Map<string, CacheEntry>();
  private readonly userAgent = 'public-promo-monitor/1.0';
  private readonly sleepFn: SleepFn;
  private requestTail: Promise<void> = Promise.resolve();
  private lastSearchAt = 0;
  private readonly blockedUntil = new Map<string, number>();

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

  resourceBlockedUntil(resource: string): number | undefined {
    return this.blockedUntil.get(resource);
  }

  async request<T>(path: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const resource = rateLimitResourceFromPath(path) ?? 'unknown';
    const waitResources = path.startsWith('/search/') && resource !== 'search' ? [resource, 'search'] : [resource];
    const retryOnRateLimit = options.retryOnRateLimit ?? true;
    let primaryRetried = false;
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForResourceBlocks(waitResources);
      const performed = await this.withLock(() => this.performRequest<T>(path, options));
      if (performed.response) return performed.response;

      if (performed.primaryRateLimit && retryOnRateLimit && !primaryRetried) {
        primaryRetried = true;
        if (this.tokenPool.size > 1) {
          this.tokenPool.rotate();
          continue;
        }
        const waitMs = primaryRateLimitWaitMs(performed.primaryRateLimit);
        this.blockResource(resource, waitMs);
        await this.sleepOutsideLock(resource, waitMs);
        continue;
      }

      if (performed.secondaryRateLimit && attempt < SECONDARY_RATE_LIMIT_MAX_RETRIES) {
        const secondary = performed.secondaryRateLimit;
        const waitMs = secondaryRateLimitBackoffMs(secondary.retryAfter);
        console.log(JSON.stringify({
          event: 'github_secondary_rate_limit',
          at: new Date().toISOString(),
          status: secondary.status,
          resource: secondary.rateLimit.resource,
          waitMs,
          attempt: attempt + 1
        }));
        this.blockResource(secondary.rateLimit.resource ?? resource, waitMs);
        await this.sleepOutsideLock(secondary.rateLimit.resource ?? resource, waitMs);
        continue;
      }

      throw performed.error ?? performed.secondaryRateLimit?.error ?? new Error('GitHub request failed');
    }
  }

  private blockResource(resource: string, waitMs: number): void {
    this.blockedUntil.set(resource, Date.now() + Math.max(0, waitMs));
  }

  private async sleepOutsideLock(resource: string, waitMs: number): Promise<void> {
    await this.sleepFn(Math.max(0, waitMs));
    this.blockedUntil.delete(resource);
  }

  private async waitForResourceBlocks(resources: string[]): Promise<void> {
    const now = Date.now();
    let longestWait = 0;
    for (const resource of resources) {
      const until = this.blockedUntil.get(resource);
      if (!until) continue;
      const waitMs = until - now;
      if (waitMs <= 0) {
        this.blockedUntil.delete(resource);
        continue;
      }
      longestWait = Math.max(longestWait, waitMs);
    }
    if (!longestWait) return;
    await this.sleepFn(longestWait);
    for (const resource of resources) {
      if ((this.blockedUntil.get(resource) ?? Number.POSITIVE_INFINITY) <= Date.now()) this.blockedUntil.delete(resource);
    }
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

  private async performRequest<T>(path: string, options: GitHubRequestOptions): Promise<PerformedRequest<T>> {
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
    if (response.status === 304) return { response: { status: response.status, notModified: true, etag, rateLimit } };

    const text = await response.text();
    let data: T | undefined;
    try {
      data = text ? JSON.parse(text) as T : undefined;
    } catch {
      data = undefined;
    }

    if (response.status === 403 && rateLimit.remaining === 0) {
      return { primaryRateLimit: rateLimit, error: new Error(formatGitHubError(response.status, data)) };
    }

    if (isSecondaryRateLimit(response.status, rateLimit, data, retryAfter)) {
      return {
        secondaryRateLimit: {
          status: response.status,
          rateLimit,
          retryAfter,
          error: new Error(formatGitHubError(response.status, data))
        }
      };
    }

    if (!response.ok) {
      return { error: new Error(formatGitHubError(response.status, data)) };
    }
    return { response: { status: response.status, data, etag, notModified: false, rateLimit } };
  }

  async waitForRateLimit(rateLimit: RateLimitState): Promise<void> {
    if (rateLimit.remaining !== 0 || !rateLimit.reset) return;
    await this.sleepFn(primaryRateLimitWaitMs(rateLimit));
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

function primaryRateLimitWaitMs(rateLimit: RateLimitState): number {
  if (!rateLimit.reset) return 1000;
  const waitMs = Math.max(1000, rateLimit.reset * 1000 - Date.now() + 1000);
  return Math.min(waitMs, 15 * 60 * 1000);
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
