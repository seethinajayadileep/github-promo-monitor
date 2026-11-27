import type { PromoCandidate } from './types.js';

export function canonicalVendor(vendor: string): string {
  return vendor.trim().toLowerCase();
}

export function canonicalCode(code: string): string {
  return code.trim().replace(/[.,;:!?)\]]+$/g, '').toUpperCase();
}

export function promoIdentity(candidate: Pick<PromoCandidate, 'vendor' | 'code'>): string {
  return `${canonicalVendor(candidate.vendor)}::${canonicalCode(candidate.code)}`;
}

export function dedupeCandidates(candidates: PromoCandidate[]): PromoCandidate[] {
  const byIdentity = new Map<string, PromoCandidate>();
  for (const candidate of candidates) {
    const normalized = { ...candidate, code: canonicalCode(candidate.code) };
    const key = promoIdentity(normalized);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, normalized);
      continue;
    }
    const existingScore = confidenceScore(existing.confidence);
    const nextScore = confidenceScore(normalized.confidence);
    const preferred = nextScore > existingScore ? normalized : existing;
    const earliest = minDate(existing.sourceDate, normalized.sourceDate);
    const latest = maxDate(existing.sourceDate, normalized.sourceDate);
    byIdentity.set(key, {
      ...preferred,
      sourceDate: earliest ?? latest,
      snippet: preferred.snippet || (preferred === normalized ? existing.snippet : normalized.snippet)
    });
  }
  return [...byIdentity.values()];
}

export function confidenceScore(confidence: 'high' | 'medium' | 'low'): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
}

function minDate(a?: Date, b?: Date): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a?: Date, b?: Date): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
