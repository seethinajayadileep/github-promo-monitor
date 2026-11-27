import type { VendorConfig } from './types.js';

function quoteTerm(term: string): string {
  return term.includes(' ') ? `"${term.replace(/"/g, '')}"` : term;
}

/** Bundle vendors into a small number of broad OR query groups. */
export function buildVendorQueryBundles(vendors: VendorConfig[], maxQueries = 7): string[] {
  const groups: string[][] = Array.from({ length: Math.max(1, Math.min(maxQueries, vendors.length)) }, () => []);
  vendors.forEach((vendor, index) => {
    const terms = [...new Set([vendor.name, ...vendor.keywords])].slice(0, 3).map(quoteTerm);
    groups[index % groups.length].push(`(${terms.join(' OR ')})`);
  });
  return groups.filter((group) => group.length).map((group) => group.join(' OR '));
}

export function promoCueQuery(): string {
  return '("promo code" OR coupon OR "free credits" OR "hackathon credits" OR "use code" OR redeem OR "partner perk")';
}

export function buildSearchQuery(bundle: string): string {
  return `${promoCueQuery()} ${bundle}`;
}

export function addCommitDateWindow(query: string, start: string, end: string): string {
  return `${query} committer-date:${start}..${end}`;
}
