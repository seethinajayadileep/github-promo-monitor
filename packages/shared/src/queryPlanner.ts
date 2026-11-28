import type { VendorConfig } from './types.js';

/** GitHub Search REST API: queries may not exceed 256 characters. */
export const GITHUB_SEARCH_MAX_CHARS = 256;

/** GitHub Search REST API: at most five AND / OR / NOT operators per query. */
export const GITHUB_SEARCH_MAX_OPERATORS = 5;

/**
 * Reserved suffix budget so the same base query stays valid after
 * `committer-date:` (commits/backfill) or `is:issue` / `is:pr` is appended.
 */
/** Room for an hour-level `committer-date:` or `created:` suffix. */
export const GITHUB_SEARCH_QUALIFIER_RESERVE = 72;

/** High-signal promo cues for commit and issue search (one OR, so four operators remain). */
export const DEFAULT_PROMO_CUE = '"promo code" OR coupon';

/** Legacy `/search/code` supports quoted phrases and OR, but not parenthesized groups. */
export const CODE_SEARCH_CUES = ['"promo code"', 'coupon'] as const;

export const CODE_SEARCH_QUALIFIERS = ['filename:README.md', 'path:docs'] as const;

function quoteTerm(term: string): string {
  const cleaned = term.trim().replace(/"/g, '');
  return cleaned.includes(' ') ? `"${cleaned}"` : cleaned;
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function wrapIfBoolean(expr: string): string {
  const trimmed = expr.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return trimmed;
  if (countBooleanOperators(trimmed) === 0) return trimmed;
  return `(${trimmed})`;
}

/** Count explicit AND / OR / NOT operators, ignoring those inside quoted phrases. */
export function countBooleanOperators(query: string): number {
  const stripped = query.replace(/"[^"]*"/g, ' ');
  return stripped.match(/\b(?:AND|OR|NOT)\b/gi)?.length ?? 0;
}

export function isValidGitHubSearchQuery(query: string, reserveChars = 0): boolean {
  const normalized = normalizeQuery(query);
  if (!normalized) return false;
  if (normalized.length + reserveChars > GITHUB_SEARCH_MAX_CHARS) return false;
  return countBooleanOperators(normalized) <= GITHUB_SEARCH_MAX_OPERATORS;
}

export function promoCueQuery(): string {
  return DEFAULT_PROMO_CUE;
}

function normalizeTermKey(value: string): string {
  return value.trim().replace(/"/g, '').toLowerCase();
}

/**
 * Unique vendor names plus distinctive aliases (e.g. ChatGPT, Claude).
 * Keywords that merely extend the vendor name ("OpenAI API", "Cursor Pro")
 * are skipped so query count stays within GitHub's 30 search req/min budget.
 */
export function collectVendorSearchTerms(vendors: VendorConfig[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (raw: string): void => {
    const cleaned = raw.trim().replace(/"/g, '');
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(quoteTerm(cleaned));
  };
  for (const vendor of vendors) {
    add(vendor.name);
    const nameKey = normalizeTermKey(vendor.name);
    for (const keyword of vendor.keywords) {
      const key = normalizeTermKey(keyword);
      if (!key || key === nameKey) continue;
      if (key.includes(nameKey) || nameKey.includes(key)) continue;
      add(keyword);
    }
  }
  return terms;
}

export function formatCueAndTerms(cue: string, terms: string[]): string {
  if (!terms.length) return normalizeQuery(wrapIfBoolean(cue));
  if (terms.length === 1) return normalizeQuery(`${wrapIfBoolean(cue)} AND ${terms[0]}`);
  return normalizeQuery(`${wrapIfBoolean(cue)} AND (${terms.join(' OR ')})`);
}

/**
 * One vendor term per commit/issue query. GitHub drops a parenthesized
 * `AND (A OR B OR C)` group, so every vendor in a bundle used to see the same hits.
 */
export function buildSearchQueries(
  vendors: VendorConfig[],
  options?: { cue?: string; reserveChars?: number }
): string[] {
  const cue = options?.cue ?? DEFAULT_PROMO_CUE;
  const reserveChars = options?.reserveChars ?? GITHUB_SEARCH_QUALIFIER_RESERVE;
  return collectVendorSearchTerms(vendors).map((term) => {
    const query = formatCueAndTerms(cue, [term]);
    if (/\([^)]*\bOR\b[^)]*\)/i.test(query.replace(/\([^)]*promo code[^)]*\)/i, ''))) {
      throw new Error(`Vendor OR group is not allowed in commit/issue search: ${query}`);
    }
    if (!isValidGitHubSearchQuery(query, reserveChars)) {
      throw new Error(`Cannot fit term into a valid GitHub Search query: ${term}`);
    }
    return query;
  });
}

/**
 * Legacy `/search/code` queries: no parentheses, one cue, one vendor term,
 * and one path/filename qualifier. Implicit AND only (zero boolean operators).
 */
export function buildCodeSearchQueries(
  vendors: VendorConfig[],
  options?: { cues?: readonly string[]; qualifiers?: readonly string[] }
): string[] {
  const cues = options?.cues ?? CODE_SEARCH_CUES;
  const qualifiers = options?.qualifiers ?? CODE_SEARCH_QUALIFIERS;
  const terms = [...new Set(vendors.map((vendor) => quoteTerm(vendor.name)).filter(Boolean))];
  const queries: string[] = [];
  for (const cue of cues) {
    for (const term of terms) {
      for (const qualifier of qualifiers) {
        const query = normalizeQuery(`${cue} ${term} ${qualifier}`);
        if (query.includes('(') || query.includes(')')) {
          throw new Error(`Code search query must not use parentheses: ${query}`);
        }
        if (!isValidGitHubSearchQuery(query)) {
          throw new Error(`Code search query exceeds GitHub Search limits: ${query}`);
        }
        queries.push(query);
      }
    }
  }
  return queries;
}

export function addCommitDateWindow(query: string, start: string, end: string): string {
  return normalizeQuery(`${query} committer-date:${start}..${end}`);
}

export function addRecentCommitDateWindow(query: string, days: number, now = new Date()): string {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Math.floor(days)) + 1);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return addCommitDateWindow(query, iso(start), iso(end));
}

export function addIssueQualifier(query: string, kind: 'issue' | 'pr' = 'issue'): string {
  const qualifier = kind === 'pr' ? 'is:pr' : 'is:issue';
  return normalizeQuery(`${query} ${qualifier}`);
}

export function addIssueDateWindow(query: string, start: string, end: string): string {
  return normalizeQuery(`${addIssueQualifier(query, 'issue')} created:${start}..${end}`);
}

/** Smallest slice. GitHub accepts hour-level timestamps; we do not cut finer than this. */
export const MIN_SEARCH_SLICE_MS = 60 * 60 * 1000;

export function formatSearchInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Inclusive date-only end becomes the next UTC midnight so slices do not overlap a whole day. */
export function parseBoundedWindow(spec: string): { start: Date; endExclusive: Date } | null {
  const match = spec.match(/^(\S+)\.\.(\S+)$/);
  if (!match) return null;
  const start = parseSearchInstant(match[1], false);
  const endExclusive = parseSearchInstant(match[2], true);
  if (!start || !endExclusive || endExclusive.getTime() <= start.getTime()) return null;
  return { start, endExclusive };
}

function parseSearchInstant(value: string, inclusiveDateEnd: boolean): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return null;
    if (inclusiveDateEnd) date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Split a window in half. Returns null once the slice is an hour or smaller. */
export function halveSearchWindow(start: Date, endExclusive: Date): { left: string; right: string } | null {
  const span = endExclusive.getTime() - start.getTime();
  if (span <= MIN_SEARCH_SLICE_MS) return null;
  const mid = new Date(start.getTime() + Math.floor(span / 2));
  if (mid.getTime() <= start.getTime() || mid.getTime() >= endExclusive.getTime()) return null;
  return {
    left: `${formatSearchInstant(start)}..${formatSearchInstant(mid)}`,
    right: `${formatSearchInstant(mid)}..${formatSearchInstant(endExclusive)}`
  };
}

export function pagesNeededForTotal(totalCount: number, pageSize: number, maxPages: number): number {
  if (pageSize <= 0) return 1;
  if (totalCount <= 0) return 1;
  const capped = Math.min(totalCount, 1000);
  return Math.min(Math.max(1, maxPages), Math.max(1, Math.ceil(capped / pageSize)));
}
