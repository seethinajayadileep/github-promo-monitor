import { describe, expect, it } from 'vitest';
import { extractPassOne } from '../src/extractor.js';
import type { VendorConfig } from '../src/types.js';

const vendors: VendorConfig[] = [
  { id: 'openai', name: 'OpenAI', category: 'ai', domains: ['openai.com', 'platform.openai.com'], keywords: ['OpenAI', 'ChatGPT'] },
  { id: 'firecrawl', name: 'Firecrawl', category: 'developer-tools', domains: ['firecrawl.dev'], keywords: ['Firecrawl'] }
];

function extract(text: string) {
  return extractPassOne({
    text,
    vendors,
    sourceUrl: 'https://github.com/example/repo/blob/main/README.md',
    sourceType: 'code',
    repoFullName: 'example/repo',
    path: 'README.md'
  });
}

describe('stage 3 pass-one extractor', () => {
  it('requires both a sharing cue and target vendor', () => {
    expect(extract('HACK2025 is mentioned without a cue or vendor').candidates).toHaveLength(0);
    expect(extract('Use code HACK2025 for savings').candidates).toHaveLength(0);
    expect(extract('OpenAI launched a new model called HACK2025').candidates).toHaveLength(0);
  });

  it('extracts an intentional public vendor promo', () => {
    const result = extract('Hackathon credits: use code HACK2025 for OpenAI API credits. Redeem at https://platform.openai.com/ before 2026-02-01');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ vendor: 'OpenAI', code: 'HACK2025', category: 'ai' });
    expect(result.candidates[0].redeemUrl).toContain('openai.com');
    expect(result.candidates[0].confidence).not.toBe('low');
  });

  it('blocks generic uppercase stopwords and vendor names', () => {
    const result = extract('Use code OPENAI for OpenAI credits and see README HTTPS API');
    expect(result.candidates.map((item) => item.code)).not.toContain('OPENAI');
    expect(result.candidates.map((item) => item.code)).not.toContain('README');
  });

  it('extracts mixed-case codes when they contain digits or separators', () => {
    const result = extract('Use code Hackathon-2025 for OpenAI free credits.');
    expect(result.candidates.map((item) => item.code)).toContain('HACKATHON-2025');
  });

  it('does not sweep unrelated uppercase words elsewhere in a large document', () => {
    const result = extract('Use code HACK2025 for OpenAI credits.\n\nInstallation notes: CONFIGURATION DEPLOYMENT PRODUCTION');
    expect(result.candidates.map((item) => item.code)).toEqual(['HACK2025']);
  });

  it('drops secret-bearing input before extraction', () => {
    expect(extract('Use code HACK2025 for OpenAI credits sk-liveabc1234567890').droppedReason).toMatch(/^stage1-/);
    expect(extract('Use code HACK2025 for OpenAI credits sk-liveabc1234567890').candidates).toHaveLength(0);
  });
});
