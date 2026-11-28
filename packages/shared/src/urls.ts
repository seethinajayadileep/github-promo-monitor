const TRAILING_URL_PUNCTUATION = /[`'\".,;:!?)\]}>]+$/g;

export function sanitizeRedeemUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim().replace(/^<+|>+$/g, '').replace(TRAILING_URL_PUNCTUATION, '');
  while (value && /[`'\".,;:!?)\]}>]$/.test(value)) {
    value = value.replace(TRAILING_URL_PUNCTUATION, '');
  }
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith('.git') || path.includes('.git/')) return undefined;
  if (host === 'api.github.com' || host.startsWith('api.') || /(?:^|\/)api(?:\/|$)/.test(path)) return undefined;
  return parsed.toString();
}

export function isSafeHttpUrl(raw: string | null | undefined): boolean {
  return sanitizeRedeemUrl(raw) !== undefined;
}
