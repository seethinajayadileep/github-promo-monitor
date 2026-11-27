import { describe, expect, it } from 'vitest';
import { canonicalCode, canonicalVendor, dedupeCandidates, promoIdentity } from '../src/dedupe.js';
import type { PromoCandidate } from '../src/types.js';

function candidate(code: string, confidence: 'high' | 'medium' | 'low', sourceUrl = 'https://github.com/a/b'): PromoCandidate {
  return {
    vendor: 'OpenAI',
    code,
    category: 'ai',
    offerSummary: 'credits',
    sourceUrl,
    sourceType: 'code',
    repoFullName: 'a/b',
    confidence,
    snippet: 'use code'
  };
}

describe('deduplication', () => {
  it('canonicalizes vendor case-insensitively and code uppercase', () => {
    expect(canonicalVendor(' OpenAI ')).toBe('openai');
    expect(canonicalCode('hack2025')).toBe('HACK2025');
    expect(promoIdentity({ vendor: 'OpenAI', code: 'hack2025' })).toBe('openai::HACK2025');
  });

  it('dedupes repeated vendor/code pairs and prefers higher confidence', () => {
    const rows = dedupeCandidates([candidate('hack2025', 'low'), candidate('HACK2025', 'high')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('HACK2025');
    expect(rows[0].confidence).toBe('high');
  });

  it('keeps distinct vendors and distinct codes', () => {
    const other = { ...candidate('HACK2025', 'medium'), vendor: 'Render' };
    const rows = dedupeCandidates([candidate('HACK2025', 'high'), other, candidate('OTHER2025', 'medium')]);
    expect(rows).toHaveLength(3);
  });
});
