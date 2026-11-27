import type { VendorConfig } from './types.js';

const CRYPTO_SPAM_PATTERN = /\b(crypto(?:currency)?|web3|airdrop(?:s)?|tokenomics|solana|ethereum|eth\b|btc\b|bitcoin|wallet(?:s)?|casino|betting|sportsbook|referral[- ]farm|mining|nft mint|defi|memecoin)\b/i;
const BULK_COUPON_REPO_PATTERN = /(?:^|\/)(?:free-?coupons?|coupon-?spam|promo-?spam|discount-?dump)(?:[-_.\/]|$)/i;
const PROMO_LIKE_TOKEN = /\b[A-Z][A-Z0-9_-]{4,31}\b/g;

export interface SpamInput {
  text: string;
  repoFullName?: string;
  path?: string;
  vendors?: VendorConfig[];
}

function countVendorMentions(text: string, vendors: VendorConfig[] = []): number {
  const lower = text.toLowerCase();
  return vendors.reduce((count, vendor) => {
    const names = [vendor.name, ...vendor.keywords].map((value) => value.toLowerCase());
    return count + (names.some((name) => lower.includes(name)) ? 1 : 0);
  }, 0);
}

export function isCryptoOrSpam(input: SpamInput): boolean {
  const combined = `${input.repoFullName ?? ''}\n${input.path ?? ''}\n${input.text}`;
  if (CRYPTO_SPAM_PATTERN.test(combined)) return true;
  if (BULK_COUPON_REPO_PATTERN.test(input.repoFullName ?? '')) return true;
  return isBulkCodeDump(input.text, input.vendors ?? []);
}

export function isBulkCodeDump(text: string, vendors: VendorConfig[] = []): boolean {
  const tokens = new Set((text.match(PROMO_LIKE_TOKEN) ?? []).map((token) => token.toUpperCase()));
  if (tokens.size <= 15) return false;
  return countVendorMentions(text, vendors) < 3;
}

export function cryptoOrSpamReason(input: SpamInput): string | null {
  const combined = `${input.repoFullName ?? ''}\n${input.path ?? ''}\n${input.text}`;
  if (CRYPTO_SPAM_PATTERN.test(combined)) return 'crypto-web3-or-gambling';
  if (BULK_COUPON_REPO_PATTERN.test(input.repoFullName ?? '')) return 'bulk-coupon-spam-repo';
  if (isBulkCodeDump(input.text, input.vendors ?? [])) return 'bulk-unrelated-code-dump';
  return null;
}
