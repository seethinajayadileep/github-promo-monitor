import { describe, expect, it } from 'vitest';
import { containsSecret, rejectSecrets } from '../src/secrets.js';

describe('stage 1 hard secret/credential rejector', () => {
  it.each([
    'sk-liveabc1234567890',
    'ghp_abcdef1234567890',
    'gho_abcdef1234567890',
    'ghu_abcdef1234567890',
    'github_pat_abcdefghijklmnop123456',
    'AIzaSyA12345678901234567890',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-123456789012-abcdefghijkl',
    'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
    'Bearer abcdefghijklmnop123456',
    'API_KEY=abc123456789',
    'SECRET=abc123456789',
    'TOKEN=abc123456789',
    'PASSWORD=abc123456789',
    'PRIVATE_KEY=abc123456789',
    'OPENAI_API_KEY=abc123456789',
    'export GITHUB_TOKEN=abc123456789',
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  ])('rejects credential shape %s', (value) => {
    expect(containsSecret(value)).toBe(true);
  });

  it('rejects high-entropy strings over 24 chars without promo structure', () => {
    expect(containsSecret('use code x9Qv27LmZr41TbN83PsaWeyu0')).toBe(true);
  });

  it('does not reject ordinary public promo codes', () => {
    expect(containsSecret('Use code HACKATHON2025 for OpenAI credits')).toBe(false);
    expect(containsSecret('Redeem FIRE-CRAWL-CREDITS at checkout')).toBe(false);
  });

  it('returns only a reason label and never echoes secret material', () => {
    const secret = 'sk-liveabc1234567890';
    const result = rejectSecrets(`prefix ${secret} suffix`);
    expect(result.rejected).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
