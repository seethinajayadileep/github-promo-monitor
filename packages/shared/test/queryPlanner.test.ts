import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_SEARCH_MAX_CHARS,
  GITHUB_SEARCH_MAX_OPERATORS,
  GITHUB_SEARCH_QUALIFIER_RESERVE,
  addCommitDateWindow,
  addIssueQualifier,
  addRecentCommitDateWindow,
  buildCodeSearchQueries,
  buildSearchQueries,
  collectVendorSearchTerms,
  countBooleanOperators,
  isValidGitHubSearchQuery,
  promoCueQuery
} from '../src/queryPlanner.js';
import type { VendorConfig } from '../src/types.js';

const vendors: VendorConfig[] = Array.from({ length: 14 }, (_, index) => ({
  id: `v${index}`,
  name: `Vendor${index}`,
  category: 'ai',
  domains: [`vendor${index}.com`],
  keywords: [`Vendor ${index}`]
}));

const liveVendors: VendorConfig[] = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../vendors.json'), 'utf8')
) as VendorConfig[];

describe('GitHub query planner', () => {
  it('counts boolean operators outside quoted phrases', () => {
    expect(countBooleanOperators('"promo code" OR coupon')).toBe(1);
    expect(countBooleanOperators('("promo code" OR coupon) AND (OpenAI OR Anthropic OR Vercel)')).toBe(4);
    expect(countBooleanOperators('"this AND that OR not" coupon')).toBe(0);
  });

  it('packs vendor terms into queries within GitHub Search limits', () => {
    const queries = buildSearchQueries(vendors);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join(' ')).toContain('Vendor0');
    expect(queries.join(' ')).toContain('"Vendor 13"');
    expect(queries.every((query) => query.includes('"promo code"') && query.includes('AND'))).toBe(true);
    for (const query of queries) {
      expect(query.length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS - GITHUB_SEARCH_QUALIFIER_RESERVE);
      expect(countBooleanOperators(query)).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_OPERATORS);
    }
  });

  it('adds commit date windows and issue qualifiers without exceeding limits', () => {
    const [query] = buildSearchQueries(vendors.slice(0, 4));
    const dated = addCommitDateWindow(query, '2025-01-01', '2025-01-07');
    const issues = addIssueQualifier(query, 'issue');
    expect(dated).toContain('committer-date:2025-01-01..2025-01-07');
    expect(issues).toContain('is:issue');
    expect(isValidGitHubSearchQuery(dated)).toBe(true);
    expect(isValidGitHubSearchQuery(issues)).toBe(true);
  });

  it('adds a rolling recent committer-date window for live commit scans', () => {
    const recent = addRecentCommitDateWindow('coupon OpenAI', 7, new Date('2026-02-10T15:00:00Z'));
    expect(recent).toBe('coupon OpenAI committer-date:2026-02-04..2026-02-10');
  });

  it('keeps every generated query for all live vendors within GitHub Search limits', () => {
    expect(liveVendors).toHaveLength(48);
    const queries = buildSearchQueries(liveVendors);
    expect(queries.length).toBeGreaterThan(0);
    // 12 queries × (commits + issues) stays under GitHub's 30 search req/min.
    expect(queries.length).toBeLessThanOrEqual(15);
    const terms = collectVendorSearchTerms(liveVendors);
    expect(terms).toContain('OpenAI');
    expect(terms).toContain('ChatGPT');
    expect(terms).not.toContain('"OpenAI API"');
    const covered = queries.join(' ');
    for (const term of terms) {
      expect(covered).toContain(term);
    }

    for (const query of queries) {
      expect(query.length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS);
      expect(countBooleanOperators(query)).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_OPERATORS);
      expect(isValidGitHubSearchQuery(query, GITHUB_SEARCH_QUALIFIER_RESERVE)).toBe(true);
      expect(isValidGitHubSearchQuery(addCommitDateWindow(query, '2020-01-01', '2020-01-07'))).toBe(true);
      expect(isValidGitHubSearchQuery(addIssueQualifier(query, 'issue'))).toBe(true);
      expect(isValidGitHubSearchQuery(addIssueQualifier(query, 'pr'))).toBe(true);
    }
  });

  it('builds parenthesis-free code search queries within limits', () => {
    const queries = buildCodeSearchQueries(liveVendors);
    expect(queries.length).toBe(liveVendors.length * 2 * 2);
    for (const query of queries) {
      expect(query).not.toMatch(/[()]/);
      expect(query.length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS);
      expect(countBooleanOperators(query)).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_OPERATORS);
      expect(isValidGitHubSearchQuery(query)).toBe(true);
    }
    expect(queries.some((query) => query === '"promo code" OpenAI filename:README.md')).toBe(true);
    expect(queries.some((query) => query === 'coupon Vercel path:docs')).toBe(true);
  });

  it('uses a promo cue that is already within the operator limit', () => {
    expect(countBooleanOperators(promoCueQuery())).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_OPERATORS);
    expect(promoCueQuery().length).toBeLessThanOrEqual(GITHUB_SEARCH_MAX_CHARS);
  });
});
