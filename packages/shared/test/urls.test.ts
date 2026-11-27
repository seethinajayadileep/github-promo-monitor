import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl, sanitizeRedeemUrl } from '../src/urls.js';

describe('redeem URL safety', () => {
  it('strips trailing markdown punctuation from valid http URLs', () => {
    expect(sanitizeRedeemUrl('https://example.com/redeem`.')).toBe('https://example.com/redeem');
    expect(sanitizeRedeemUrl('https://example.com/redeem),')).toBe('https://example.com/redeem');
  });

  it('rejects non-http URLs and javascript XSS hrefs', () => {
    expect(sanitizeRedeemUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeRedeemUrl('data:text/html;base64,AAAA')).toBeUndefined();
    expect(sanitizeRedeemUrl('ftp://example.com/file')).toBeUndefined();
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects git repositories and API endpoints as redeem links', () => {
    expect(sanitizeRedeemUrl('https://github.com/acme/repo.git')).toBeUndefined();
    expect(sanitizeRedeemUrl('https://api.example.com/coupons')).toBeUndefined();
    expect(sanitizeRedeemUrl('https://example.com/api/redeem')).toBeUndefined();
    expect(sanitizeRedeemUrl('https://example.com/redeem')).toBe('https://example.com/redeem');
  });
});
