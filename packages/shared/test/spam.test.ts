import { describe, expect, it } from 'vitest';
import { cryptoOrSpamReason, isBulkCodeDump, isCryptoOrSpam } from '../src/spam.js';
import type { VendorConfig } from '../src/types.js';

const vendors: VendorConfig[] = [
  { id: 'openai', name: 'OpenAI', category: 'ai', domains: ['openai.com'], keywords: ['OpenAI'] },
  { id: 'render', name: 'Render', category: 'cloud', domains: ['render.com'], keywords: ['Render'] },
  { id: 'groq', name: 'Groq', category: 'ai', domains: ['groq.com'], keywords: ['Groq'] }
];

describe('stage 2 crypto/web3 and spam exclusion', () => {
  it.each([
    'solana airdrop promo code',
    'ethereum wallet bonus',
    'web3 tokenomics credits',
    'casino betting coupon',
    'referral-farm code list'
  ])('rejects excluded topic %s', (text) => {
    expect(isCryptoOrSpam({ text, vendors })).toBe(true);
  });

  it('rejects bulk coupon-spam repository names', () => {
    expect(isCryptoOrSpam({ text: 'promo code OpenAI FREE2025', repoFullName: 'someone/free-coupons-daily', vendors })).toBe(true);
    expect(cryptoOrSpamReason({ text: 'ok', repoFullName: 'someone/free-coupons-daily', vendors })).toBe('bulk-coupon-spam-repo');
  });

  it('rejects files dumping more than 15 unrelated codes', () => {
    const text = Array.from({ length: 16 }, (_, index) => `CODE${index}XYZ`).join('\n');
    expect(isBulkCodeDump(text, vendors)).toBe(true);
  });

  it('allows intentional SaaS promo text', () => {
    expect(isCryptoOrSpam({ text: 'Use code HACK2025 for OpenAI hackathon credits', repoFullName: 'team/project', vendors })).toBe(false);
  });
});
