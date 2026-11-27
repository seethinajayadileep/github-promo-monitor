export interface RateLimitState {
  remaining?: number;
  reset?: number;
  limit?: number;
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

export class GitHubClient {
  readonly tokenPool: GitHubTokenPool;
  private readonly etagCache = new Map<string, CacheEntry>();
  private readonly userAgent = 'public-promo-monitor/1.0';

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.tokenPool = new GitHubTokenPool(env);
  }

  getEtag(cacheKey: string): string | undefined {
    return this.etagCache.get(cacheKey)?.etag;
  }

  setEtag(cacheKey: string, etag: string): void {
    this.etagCache.set(cacheKey, { etag });
  }

  async request<T>(path: string, options: { cacheKey?: string; accept?: string; method?: string; body?: unknown; retryOnRateLimit?: boolean } = {}): Promise<GitHubResponse<T>> {
    const retryOnRateLimit = options.retryOnRateLimit ?? true;
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
    const rateLimit = {
      remaining: numberHeader(response.headers.get('x-ratelimit-remaining')),
      reset: numberHeader(response.headers.get('x-ratelimit-reset')),
      limit: numberHeader(response.headers.get('x-ratelimit-limit'))
    };
    const etag = response.headers.get('etag') ?? undefined;
    if (options.cacheKey && etag) this.etagCache.set(options.cacheKey, { etag });
    if (response.status === 304) return { status: response.status, notModified: true, etag, rateLimit };

    const text = await response.text();
    const data = text ? JSON.parse(text) as T : undefined;
    if (response.status === 403 && rateLimit.remaining === 0 && retryOnRateLimit) {
      if (this.tokenPool.size > 1) this.tokenPool.rotate();
      else await this.waitForRateLimit(rateLimit);
      return this.request<T>(path, { ...options, retryOnRateLimit: false });
    }
    if (!response.ok && response.status !== 304) {
      const message = data && typeof data === 'object' && 'message' in data ? String((data as { message?: unknown }).message) : `HTTP ${response.status}`;
      throw new Error(`GitHub request failed: ${message}`);
    }
    return { status: response.status, data, etag, notModified: false, rateLimit };
  }

  async waitForRateLimit(rateLimit: RateLimitState): Promise<void> {
    if (rateLimit.remaining !== 0 || !rateLimit.reset) return;
    const waitMs = Math.max(1000, rateLimit.reset * 1000 - Date.now() + 1000);
    await sleep(Math.min(waitMs, 15 * 60 * 1000));
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

function numberHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function encodeQuery(query: string): string {
  return encodeURIComponent(query.replace(/\s+/g, ' ').trim());
}
