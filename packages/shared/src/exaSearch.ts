import type { SourceType, VendorConfig } from './types.js';

/** Published Search list prices, per 1,000 requests. https://exa.ai/pricing */
export const EXA_LIST_PRICE_PER_THOUSAND = {
  lite: 4,
  auto: 7,
  deep: 12
} as const;

export const EXA_EXTRA_RESULT_PER_THOUSAND = 1;
export const EXA_INCLUDED_RESULTS = 10;
export const EXA_MAX_RESULTS = 100;

export const EXA_COST_NOTE = 'List prices are Exa\'s published Search rates: lite $4, auto $7, and deep $12 per 1,000 requests for up to 10 results, plus $1 per 1,000 requests for each returned result above 10. deep-lite has no published per-request price in that table. When a response includes costDollars.total, that amount is stored instead. Highlights are not given a separate contents charge in the list-price estimate.';

export const EXA_SEARCH_TYPES = ['auto', 'lite', 'deep', 'deep-lite'] as const;
export type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];

export interface ExaSearchSettings {
  type: ExaSearchType;
  numResults: number;
  /** Null omits the field. Lite never sends it; the API rejects maxAgeHours on lite. */
  maxAgeHours: number | null;
  publishedWithinDays: number | null;
  timeoutMs: number;
  now?: Date;
}

export interface PublicExaSettings extends ExaSearchSettings {
  configured: boolean;
  intervalMs: number;
}

export interface ExaHit {
  url: string;
  title: string;
  text: string;
  publishedDate: string | null;
}

const EXA_SEARCH_URL = 'https://api.exa.ai/search';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function exaConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.EXA_API_KEY && env.EXA_API_KEY.trim());
}

/** Public tuning only. The API key is never copied onto this object. */
export function publicExaSettings(env: NodeJS.ProcessEnv = process.env, now = new Date()): PublicExaSettings {
  const typeRaw = (env.EXA_SEARCH_TYPE || 'auto').trim().toLowerCase();
  const type: ExaSearchType = EXA_SEARCH_TYPES.includes(typeRaw as ExaSearchType) ? typeRaw as ExaSearchType : 'auto';
  const numResults = clampInt(env.EXA_NUM_RESULTS ?? 10, 1, EXA_MAX_RESULTS, 10);
  let maxAgeHours: number | null = 24;
  if (env.EXA_MAX_AGE_HOURS == null || env.EXA_MAX_AGE_HOURS === '' || env.EXA_MAX_AGE_HOURS === 'omit') {
    maxAgeHours = env.EXA_MAX_AGE_HOURS == null ? 24 : null;
  } else {
    maxAgeHours = clampInt(env.EXA_MAX_AGE_HOURS, -1, 720, 24);
  }
  if (type === 'lite') maxAgeHours = null;
  const publishedRaw = env.EXA_PUBLISHED_WITHIN_DAYS;
  const publishedWithinDays = publishedRaw == null || publishedRaw === ''
    ? 21
    : clampInt(publishedRaw, 0, 3650, 21);
  const requestedInterval = clampInt(env.EXA_INTERVAL_MS ?? 1_800_000, 1, 86_400_000, 1_800_000);
  const fastLane = clampInt(env.FAST_LANE_INTERVAL_MS ?? 90_000, 1, 86_400_000, 90_000);
  return {
    configured: exaConfigured(env),
    type,
    numResults,
    maxAgeHours,
    publishedWithinDays: publishedWithinDays > 0 ? publishedWithinDays : null,
    timeoutMs: clampInt(env.EXA_TIMEOUT_MS ?? 30_000, 5_000, 120_000, 30_000),
    intervalMs: Math.max(requestedInterval, fastLane),
    now
  };
}

export function buildExaVendorQuery(vendor: VendorConfig): string {
  const domains = vendor.domains.slice(0, 3).join(', ');
  const domainText = domains ? ` (${domains})` : '';
  return `Public GitHub repository page that intentionally shares a promo code, coupon, or hackathon credits for ${vendor.name}${domainText}. README, docs, issue, or commit on github.com.`;
}

export function buildExaSearchBody(query: string, settings: ExaSearchSettings): Record<string, unknown> {
  const contents: Record<string, unknown> = { highlights: true };
  if (settings.type !== 'lite' && settings.maxAgeHours != null) {
    contents.maxAgeHours = settings.maxAgeHours;
  }
  const body: Record<string, unknown> = {
    query,
    type: settings.type,
    numResults: Math.min(EXA_MAX_RESULTS, Math.max(1, Math.floor(settings.numResults))),
    includeDomains: ['github.com'],
    contents
  };
  if (settings.publishedWithinDays && settings.publishedWithinDays > 0) {
    const start = new Date(settings.now ?? Date.now());
    start.setUTCDate(start.getUTCDate() - Math.floor(settings.publishedWithinDays));
    body.startPublishedDate = start.toISOString();
  }
  return body;
}

export function exaSearchRequest(query: string, apiKey: string, settings: ExaSearchSettings): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
} {
  return {
    url: EXA_SEARCH_URL,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey
    },
    body: buildExaSearchBody(query, settings),
    timeoutMs: settings.timeoutMs
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function readExaCostDollars(body: unknown): number | null {
  const cost = asRecord(asRecord(body)?.costDollars);
  const total = cost?.total;
  const parsed = typeof total === 'number' ? total : typeof total === 'string' ? Number(total) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 1e8) / 1e8;
}

export function estimateExaListPrice(type: string, resultsReturned: number): { usd: number; priced: boolean } {
  if (!(type in EXA_LIST_PRICE_PER_THOUSAND)) return { usd: 0, priced: false };
  const base = EXA_LIST_PRICE_PER_THOUSAND[type as keyof typeof EXA_LIST_PRICE_PER_THOUSAND];
  const results = Math.max(0, Math.floor(resultsReturned));
  const extra = Math.max(0, results - EXA_INCLUDED_RESULTS);
  const raw = (base + extra * EXA_EXTRA_RESULT_PER_THOUSAND) / 1000;
  return { usd: Math.round(raw * 1e8) / 1e8, priced: true };
}

export function resolveExaCost(type: string, resultsReturned: number, body: unknown): { usd: number | null; source: 'response' | 'list-price' | null } {
  const reported = readExaCostDollars(body);
  if (reported != null) return { usd: reported, source: 'response' };
  const estimate = estimateExaListPrice(type, resultsReturned);
  if (!estimate.priced) return { usd: null, source: null };
  return { usd: estimate.usd, source: 'list-price' };
}

export function isGithubWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname === 'www.github.com');
  } catch {
    return false;
  }
}

export function repoFromGithubUrl(value: string): string | null {
  if (!isGithubWebUrl(value)) return null;
  const parts = new URL(value).pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
}

export function sourceTypeFromGithubUrl(value: string): SourceType {
  const path = isGithubWebUrl(value) ? new URL(value).pathname : '';
  if (path.includes('/commit/')) return 'commit';
  if (path.includes('/issues/') || path.includes('/pull/')) return 'issue';
  return 'code';
}

export function parseExaHits(body: unknown): ExaHit[] {
  const results = asRecord(body)?.results;
  if (!Array.isArray(results)) return [];
  const hits: ExaHit[] = [];
  for (const item of results) {
    const record = asRecord(item);
    if (!record || typeof record.url !== 'string') continue;
    const highlights = Array.isArray(record.highlights)
      ? record.highlights.filter((part): part is string => typeof part === 'string')
      : [];
    const title = typeof record.title === 'string' ? record.title : '';
    const text = [title, ...highlights].filter(Boolean).join('\n').slice(0, 8000);
    hits.push({
      url: record.url,
      title,
      text,
      publishedDate: typeof record.publishedDate === 'string' ? record.publishedDate : null
    });
  }
  return hits;
}

export function exaHttpErrorCode(status: number): string {
  return `http-${status}`;
}

/** Short error code. Response bodies are not kept; they can echo request headers. */
export function exaTransportErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)) return 'timeout';
  return 'network-error';
}
