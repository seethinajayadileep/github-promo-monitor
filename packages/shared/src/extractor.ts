import { canonicalCode } from './dedupe.js';
import { buildLlmUsageRecord, parseProviderUsage, type LlmCallContext } from './llmUsage.js';
import { rejectSecrets } from './secrets.js';
import { isCryptoOrSpam } from './spam.js';
import { sanitizeRedeemUrl } from './urls.js';
import type { Confidence, ExtractedPromo, PromoCandidate, SourceType, VendorConfig } from './types.js';

const PUBLIC_CUES = [
  'promo code',
  'promotional code',
  'coupon',
  'discount code',
  'hackathon credits',
  'free credits',
  'use code',
  'redeem',
  'partner perk',
  'credits with code',
  'claim credits',
  'student credits'
];

const STRONG_CUES = ['promo code', 'coupon', 'discount code', 'use code', 'redeem'];
const CODE_PATTERN = /\b[A-Za-z][A-Za-z0-9_-]{4,31}\b/g;
const URL_PATTERN = /https?:\/\/[^\s)\]>\"']+/gi;
const VENDOR_PROXIMITY_CHARS = 280;

const STOPWORDS = new Set([
  'README', 'LICENSE', 'OPENAI', 'HTTPS', 'HTTP', 'API', 'JSON', 'HTML', 'CSS', 'SQL', 'TODO', 'MIT', 'Apache',
  'COPYING', 'CONTRIBUTING', 'GITHUB', 'PROMO', 'CODE', 'COUPON', 'CREDITS', 'FREE', 'REDEEM', 'DISCOUNT', 'OFFER',
  'HACKATHON', 'PARTNER', 'PERK', 'PERKS', 'STUDENT', 'CLAIM', 'VALID', 'BEFORE', 'AFTER', 'WITH', 'FROM', 'THIS', 'THAT',
  'TOKEN', 'SECRET', 'PASSWORD', 'BEARER', 'PRIVATE', 'PUBLIC', 'NODE', 'NPM', 'YARN', 'PNPM', 'ENV', 'TRUE', 'FALSE',
  'NULL', 'UNDEFINED', 'ERROR', 'WARNING', 'DEBUG', 'INFO', 'POST', 'GET', 'PUT', 'PATCH', 'DELETE'
]);

const GENERIC_COMPOUND_CODES = new Set([
  'TIME-LIMITED', 'SELF-HOSTED', 'OPEN-SOURCE', 'REAL-TIME', 'END-TO-END', 'RATE-LIMITED', 'RATE-LIMIT',
  'PRODUCTION-READY', 'CROSS-PLATFORM', 'TYPE-SAFE', 'FULL-STACK', 'FRONT-END', 'BACK-END', 'CLIENT-SIDE',
  'SERVER-SIDE', 'PRE-COMMIT', 'POST-COMMIT', 'CI-CD', 'NODE-JS', 'NEXT-JS', 'WELL-KNOWN', 'COPY-PASTE',
  'DROP-IN', 'OPT-IN', 'OPT-OUT', 'NON-COMMERCIAL', 'TRADE-OFF', 'BEST-PRACTICE', 'GET-STARTED', 'QUICK-START',
  'README-MD', 'LICENSE-MD', 'LEFT-HAND', 'RIGHT-HAND', 'CROSS-BROWSER', 'SINGLE-FILE', 'STEP-BY-STEP',
  'SPEECH-TO-TEXT', 'TEXT-TO-SPEECH', 'POST-RULING', 'ALREADY-FIXED', 'STOREFRONT-WEB', 'REVIEW-JUMP',
  'ONE-USE', 'MODEL-VIEWER', 'COUPON-CODES', 'PROP-FIRM', 'SIGN-UP', 'LOG-IN', 'CHECK-OUT', 'FREE-TIER',
  'FREE-TRIAL', 'PRO-PLAN', 'PROMO-CODE', 'CREDIT-CODE', 'GIFT-CARD', 'NO-CODE', 'LOW-CODE', 'AI-POWERED',
  'CLOUD-NATIVE', 'ZERO-SHOT', 'FEW-SHOT', 'FINE-TUNE', 'MULTI-AGENT', 'AUTO-DEPLOY', 'DARK-MODE',
  'LIGHT-MODE', 'WEB-APP', 'MOBILE-APP', 'API-KEY', 'ACCESS-TOKEN', 'AS-BUILT', 'UPSTREAM-QUALIFIED',
  'MAKE-PROMO-CODE', 'ADD-COUPON', 'COUPON-VS-COOKIE', 'BEST-5', 'BLACK-HAT-RUST',
  'STUDENT-PROGRAM', 'AUTO-APPLIED', 'FUNCTION-CALLING', 'NEW-USER'
]);

const ENV_VAR_SUFFIXES = [
  'API_KEY', 'ACCESS_TOKEN', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'ID', 'CODE', 'URL', 'URI', 'KEY',
  'HOST', 'PORT', 'ENV', 'PATH', 'DIR', 'MODE', 'FLAG', 'NAME', 'TYPE', 'VALUE', 'CONFIG', 'HEADER',
  'ENDPOINT', 'BUCKET', 'REGION', 'CLIENT', 'SERVER', 'WEBHOOK', 'AUTH', 'CREDENTIAL', 'SESSION',
  'COOKIE', 'HASH', 'SALT', 'NONCE', 'PREFIX', 'SUFFIX'
];

const ENV_VAR_NAME_PATTERN = new RegExp(
  `^(?:[A-Z][A-Z0-9]*_)+(?:${ENV_VAR_SUFFIXES.join('|')})$|^(?:${ENV_VAR_SUFFIXES.join('|')})$`
);

const GENERIC_HYPHEN_SUFFIX_PATTERN = /^(?:[A-Z]+-)+(?:BROWSER|FILE|WEB|VIEWER|CODES?|FIRM|HOSTED|SOURCE|LIMITED|STACK|TIER|TRIAL|PLAN|CARD|POWERED|NATIVE|SHOT|TUNE|AGENT|LIMIT|DEPLOY|MODE|APP|KEY|TOKEN|UP|IN|OUT|STARTED|RULING|FIXED|JUMP|USE|END|SIDE|PLATFORM|COMMIT|READY|SAFE|COMMERCIAL|PRACTICE|KNOWN|PASTE|HAND|JS|MD|QUALIFIED|BUILT)$/i;
const GENERIC_HYPHEN_BRIDGE_PATTERN = /^(?:[A-Z]+-)+(?:TO|BY|FOR)-[A-Z]+(?:-[A-Z]+)*$/i;

const CSS_UI_PARTS = new Set([
  'ITEMS', 'CENTER', 'FLEX', 'GRID', 'COL', 'COLS', 'ROW', 'ROWS', 'SPAN', 'HIDDEN', 'BLOCK', 'INLINE',
  'STICKY', 'FIXED', 'RELATIVE', 'ABSOLUTE', 'WRAP', 'GROW', 'SHRINK', 'AUTO', 'FULL', 'SCREEN',
  'JUSTIFY', 'CONTENT', 'SELF', 'PLACE', 'GAP', 'SPACE', 'PADDING', 'MARGIN', 'BORDER', 'ROUNDED',
  'SHADOW', 'OPACITY', 'FONT', 'TEXT', 'BG', 'COLOR', 'WIDTH', 'HEIGHT', 'MIN', 'MAX', 'OVERFLOW',
  'SCROLL', 'VISIBLE', 'POINTER', 'CURSOR', 'SELECT', 'ALIGN', 'LEADING', 'TRACKING', 'UPPERCASE',
  'LOWERCASE', 'TRUNCATE', 'SR', 'ONLY'
]);

const LICENSE_CODE_PATTERN = /^(?:BSD-\d+-CLAUSE|MIT-LICENSE|APACHE-?\d+(?:\.\d+)?|GPL-?(?:V)?\d+(?:\.\d+)?|LGPL-?(?:V)?\d+|AGPL-?(?:V)?\d+|MPL-?\d+(?:\.\d+)?|CC-BY(?:-[A-Z0-9]+)*|UNLICENSE)$/i;
const CVE_CODE_PATTERN = /^CVE-\d{4}-\d{4,}$/i;
const TECH_PREFIX_PATTERN = /^(?:UTF|UTF8|SHA|SHA1|SHA2|SHA3|MD5|AES|RSA|HTTP|HTTPS|TLS|SSL|ISO|RFC|IANA|IPV4|IPV6|UUID)[-_].+/i;

export const SARVAM_DEFAULT_URL = 'https://api.sarvam.ai/v2/chat/completions';
export const SARVAM_DEFAULT_MODEL = 'sarvam-105b';
export const SARVAM_MAX_TOKENS = 4096;
export const OPENAI_DEFAULT_MODEL = 'gpt-6-luna';
export const OPENAI_DEFAULT_REASONING_EFFORT = 'none';
export const OPENAI_DEFAULT_MAX_COMPLETION_TOKENS = 1024;
export const OPENAI_MAX_COMPLETION_TOKEN_CEILING = 8192;
export const OPENAI_DEFAULT_TIMEOUT_MS = 30_000;
export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

export const PROMO_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_public_promo: { type: 'boolean' },
    vendor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    code: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    offer_summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    redeem_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    expires_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['is_public_promo', 'vendor', 'code', 'offer_summary', 'redeem_url', 'expires_at', 'confidence']
} as const;

const LLM_SYSTEM_PROMPT = 'Extract only intentionally public, actionable SaaS/AI/developer-tool promotional, coupon, or credit codes a person can redeem. Never output credentials. Name the exact product or service where the code is redeemed. Never use UI or component words such as Modal, Dialog, Button, Popup, or Banner as the vendor; never answer GitHub merely because the snippet is hosted on GitHub; reject UI popup demos such as a 1-Click Coupon Modal. Reject environment-variable and identifier names (ELEVENLABS_API_KEY, DISCOUNT_CODE, ADMIN_ACCESS_TOKEN, or tokens ending in _ID, _TOKEN, _KEY, _SECRET, _CODE), placeholder strings (YOUR_CODE_HERE, PROMO123), CSS/UI tokens, license IDs, CVEs, commit SHAs, and generic English or hyphenated tech phrases (CROSS-BROWSER, STEP-BY-STEP, OPEN-SOURCE, SINGLE-FILE). If multiple real comma-separated codes are intentionally listed, return them exactly as a comma-separated code string. Return strict JSON.';

export interface PassOneInput {
  text: string;
  vendors: VendorConfig[];
  sourceUrl: string;
  sourceType: SourceType;
  repoFullName: string;
  sourceDate?: Date;
  path?: string;
}

export interface FilteredExtraction {
  candidates: PromoCandidate[];
  droppedReason?: string;
}

export type LlmProvider = 'sarvam' | 'openai' | 'gemini' | 'none';

function vendorStopwords(vendors: VendorConfig[]): Set<string> {
  const words = new Set<string>();
  for (const vendor of vendors) {
    for (const value of [vendor.name, vendor.id, ...vendor.keywords]) {
      for (const part of value.toUpperCase().split(/[^A-Z0-9]+/)) {
        if (part.length >= 4) words.add(part);
      }
    }
  }
  return words;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasPublicSharingCue(lowerText: string): boolean {
  return PUBLIC_CUES.some((cue) => lowerText.includes(cue));
}

function vendorTerms(vendor: VendorConfig): string[] {
  return [vendor.name, vendor.id, ...vendor.keywords].map((term) => term.toLowerCase()).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeVendorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findTermOccurrence(text: string, term: string): number {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, 'i');
  const match = pattern.exec(text);
  return match?.index ?? -1;
}

const AMBIGUOUS_VENDOR_TERMS = new Set(['github', 'modal', 'claude', 'neon', 'exa', 'render', 'cursor']);
const VENDOR_PRODUCT_CONTEXTS: Record<string, string[]> = {
  github: ['copilot', 'student developer pack', 'education.github.com', 'github education', 'github student'],
  modal: ['modal labs', 'modal.com', 'gpu cloud', 'serverless gpu', 'sandboxes'],
  claude: ['anthropic', 'claude.ai', 'console.anthropic.com'],
  neon: ['neon database', 'neon postgres', 'neon.tech', 'serverless postgres', 'database'],
  exa: ['exa ai', 'exa.ai', 'search api'],
  render: ['render.com', 'deploy', 'hosting', 'cloud platform', 'web service'],
  cursor: ['cursor pro', 'cursor ai', 'cursor.com', 'cursor.sh', 'editor', 'ide']
};

function requiresProductContext(vendor: VendorConfig, term: string): boolean {
  const key = normalizeVendorKey(term);
  return AMBIGUOUS_VENDOR_TERMS.has(key) && key === normalizeVendorKey(vendor.name) ||
    AMBIGUOUS_VENDOR_TERMS.has(key) && vendor.keywords.some((keyword) => normalizeVendorKey(keyword) === key);
}

function hasProductContext(text: string, index: number, length: number, vendor: VendorConfig): boolean {
  const start = Math.max(0, index - 140);
  const end = Math.min(text.length, index + length + 140);
  const nearby = text.slice(start, end).toLowerCase();
  const contexts = VENDOR_PRODUCT_CONTEXTS[vendor.id] ?? [];
  if (contexts.some((term) => nearby.includes(term))) return true;
  if (vendor.id === 'github') return false;
  return vendor.domains.some((domain) => nearby.includes(domain.toLowerCase()));
}

function matchingVendor(text: string, vendors: VendorConfig[]): VendorConfig | undefined {
  for (const vendor of vendors) {
    const terms = vendorTerms(vendor).sort((a, b) => b.length - a.length);
    for (const term of terms) {
      const index = findTermOccurrence(text, term);
      if (index < 0) continue;
      if (!requiresProductContext(vendor, term) || hasProductContext(text, index, term.length, vendor)) return vendor;
    }
  }
  return undefined;
}

function urlHostAndPath(rawUrl: string): { host: string; path: string } | undefined {
  try {
    const parsed = new URL(rawUrl.replace(/[`'\".,;:!?)\]}>]+$/g, ''));
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.toLowerCase() };
  } catch {
    return undefined;
  }
}

function domainMatches(host: string, domain: string): boolean {
  const normalized = domain.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function matchingVendorByUrl(text: string, vendors: VendorConfig[]): VendorConfig | undefined {
  const urls = text.match(URL_PATTERN) ?? [];
  for (const vendor of vendors) {
    for (const rawUrl of urls) {
      const parsed = urlHostAndPath(rawUrl);
      if (!parsed) continue;
      for (const domain of vendor.domains) {
        if (!domainMatches(parsed.host, domain)) continue;
        if (vendor.id === 'github') {
          const githubProductUrl = parsed.host === 'education.github.com' || /copilot|education|student/.test(parsed.path);
          if (!githubProductUrl) continue;
        }
        return vendor;
      }
    }
  }
  return undefined;
}

function windowAround(text: string, index: number, length: number, radius = VENDOR_PROXIMITY_CHARS): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return text.slice(start, end);
}

function matchingVendorNear(text: string, index: number, length: number, vendors: VendorConfig[]): VendorConfig | undefined {
  const nearby = windowAround(text, index, length);
  return matchingVendor(nearby, vendors) ?? matchingVendorByUrl(nearby, vendors);
}

function redemptionUrlFor(text: string, vendor?: VendorConfig): string | undefined {
  const urls = text.match(URL_PATTERN) ?? [];
  if (!vendor) return undefined;
  for (const raw of urls) {
    const url = sanitizeRedeemUrl(raw);
    if (!url) continue;
    const parsed = urlHostAndPath(url);
    if (parsed && vendor.domains.some((domain) => domainMatches(parsed.host, domain))) return url;
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

export function parseExpiryDateValue(value: string, referenceDate = new Date()): Date | undefined {
  const trimmed = value.trim().replace(/[.,;:!?)\]}>`'"]+$/g, '');
  if (!trimmed) return undefined;
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 23, 59, 59));
  const monthName = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\s+(\d{4}))?$/);
  if (monthName) {
    const month = MONTHS[monthName[1].toLowerCase()];
    if (month !== undefined) {
      const year = monthName[3] ? Number(monthName[3]) : referenceDate.getUTCFullYear();
      return new Date(Date.UTC(year, month, Number(monthName[2]), 23, 59, 59));
    }
  }
  const numeric = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (numeric) {
    const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
    return new Date(Date.UTC(year, Number(numeric[1]) - 1, Number(numeric[2]), 23, 59, 59));
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function parseExpiry(text: string, referenceDate = new Date()): Date | undefined {
  const expiryContext = /(?:expires?|valid(?:\s+(?:until|through|to))?|ends?|before|until|deadline)\s*(?:on\s+)?[|:=-]*\s*([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;
  const match = text.match(expiryContext);
  if (!match) return undefined;
  return parseExpiryDateValue(match[1], referenceDate);
}

function cleanCode(raw: string): string {
  return canonicalCode(raw).replace(/^[-_]+|[-_]+$/g, '');
}

function isCssUiCompound(token: string): boolean {
  if (!token.includes('-') || /\d/.test(token)) return false;
  const parts = token.split('-').filter(Boolean);
  return parts.length >= 2 && parts.every((part) => CSS_UI_PARTS.has(part));
}

export function isEnvVarOrIdentifierName(raw: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(raw.toUpperCase());
}

export function isRejectedCodeToken(raw: string): boolean {
  const token = raw.toUpperCase();
  if (GENERIC_COMPOUND_CODES.has(token)) return true;
  if (isEnvVarOrIdentifierName(token)) return true;
  if (LICENSE_CODE_PATTERN.test(token) || CVE_CODE_PATTERN.test(token) || TECH_PREFIX_PATTERN.test(token)) return true;
  if (/^HTTPS?-/i.test(token)) return true;
  if (/^[0-9A-F]{7,40}$/.test(token) && /[A-F]/.test(token) && /\d/.test(token)) return true;
  if (GENERIC_HYPHEN_BRIDGE_PATTERN.test(token) || GENERIC_HYPHEN_SUFFIX_PATTERN.test(token)) return true;
  if (isCssUiCompound(token)) return true;
  return false;
}

function isPlausibleCode(raw: string, original: string, stopwords: Set<string>): boolean {
  if (raw.length < 5 || raw.length > 32) return false;
  if (stopwords.has(raw) || STOPWORDS.has(raw)) return false;
  if (isRejectedCodeToken(raw)) return false;
  if (!/[A-Z]/.test(raw)) return false;
  if (/^\d+$/.test(raw)) return false;
  if (/^(?:19|20)\d{2}$/.test(raw)) return false;
  const digitCount = (raw.match(/\d/g) ?? []).length;
  const hasSeparator = /[-_]/.test(raw);
  if (digitCount > 0 || hasSeparator) return true;
  return original === original.toUpperCase() && /[AEIOU]/.test(raw);
}

export function cleanSnippetText(value: string): string {
  return normalizeWhitespace(value
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^[\s>#]+/, '')
    .replace(/(?<!\w)\*\*([^*]+)\*\*(?!\w)/g, '$1')
    .replace(/(?<!\w)__([^_]+)__(?!\w)/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
  );
}

function isUrlPunctuation(text: string, position: number): boolean {
  if (text[position] !== '.') return false;
  const before = text.slice(Math.max(0, position - 220), position + 1);
  const token = before.match(/https?:\/\/\S*$/i)?.[0];
  if (!token || token.length <= 10) return false;
  const urlTail = text.slice(position).match(/^\.\S*/)?.[0] ?? '';
  return urlTail.length > 1;
}

function sentenceBoundaryStart(text: string, index: number): number {
  for (let position = index - 1; position >= Math.max(0, index - 180); position -= 1) {
    if (text[position] === '\n') return position + 1;
    if ((text[position] === '!' || text[position] === '?' || text[position] === '.') && !isUrlPunctuation(text, position)) return position + 1;
  }
  return Math.max(0, index - 140);
}

function sentenceBoundaryEnd(text: string, index: number, length: number): number {
  const start = index + length;
  for (let position = start; position < Math.min(text.length, start + 220); position += 1) {
    if (text[position] === '\n') return position;
    if ((text[position] === '!' || text[position] === '?' || text[position] === '.') && !isUrlPunctuation(text, position)) return position + 1;
  }
  return Math.min(text.length, start + 180);
}

function sentenceAround(text: string, index: number, length: number): string {
  const start = sentenceBoundaryStart(text, index);
  const end = sentenceBoundaryEnd(text, index, length);
  return cleanSnippetText(text.slice(start, end)).slice(0, 500);
}

function scoreConfidence(context: string, vendor: VendorConfig, redeemUrl?: string): Confidence {
  const lower = context.toLowerCase();
  const strongCue = STRONG_CUES.some((cue) => lower.includes(cue));
  const vendorMentioned = vendorTerms(vendor).some((term) => lower.includes(term));
  const hasExpiry = /(?:expires?|valid until|valid through|ends?)\b/i.test(context);
  if (strongCue && vendorMentioned && (redeemUrl || hasExpiry)) return 'high';
  if (strongCue && vendorMentioned) return 'medium';
  return 'low';
}

function offerSummary(context: string, vendor: VendorConfig, code: string): string {
  const cleaned = normalizeWhitespace(context)
    .replace(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), code)
    .slice(0, 220);
  return cleaned || `${vendor.name} public promotional code ${code}`;
}

/** Stage 3 pass 1: deterministic cue + vendor/redemption URL extraction. */
export function extractPassOne(input: PassOneInput): FilteredExtraction {
  const secretRejection = rejectSecrets(input.text);
  if (secretRejection.rejected) return { candidates: [], droppedReason: `stage1-${secretRejection.reason}` };
  if (isCryptoOrSpam({ text: input.text, repoFullName: input.repoFullName, path: input.path, vendors: input.vendors })) {
    return { candidates: [], droppedReason: 'stage2-crypto-or-spam' };
  }

  const lower = input.text.toLowerCase();
  if (!hasPublicSharingCue(lower)) return { candidates: [], droppedReason: 'stage3-no-public-sharing-cue' };

  const fileVendor = matchingVendor(input.text, input.vendors) ?? matchingVendorByUrl(input.text, input.vendors);
  if (!fileVendor) return { candidates: [], droppedReason: 'stage3-no-target-vendor-or-redemption-url' };

  const vendorWords = vendorStopwords(input.vendors);
  const candidates: PromoCandidate[] = [];
  const seenCodes = new Set<string>();
  for (const match of input.text.matchAll(CODE_PATTERN)) {
    const raw = cleanCode(match[0]);
    if (!isPlausibleCode(raw, match[0], vendorWords) || seenCodes.has(raw)) continue;
    const index = match.index ?? 0;
    const vendor = matchingVendorNear(input.text, index, match[0].length, input.vendors);
    if (!vendor) continue;
    const context = sentenceAround(input.text, index, match[0].length);
    const contextLower = context.toLowerCase();
    if (!hasPublicSharingCue(contextLower)) continue;
    const contextRedeemUrl = redemptionUrlFor(context, vendor);
    const confidence = scoreConfidence(context, vendor, contextRedeemUrl);
    // Low-confidence hits kept only for a docs URL elsewhere in the file are dropped.
    if (confidence === 'low' && !contextRedeemUrl) continue;
    seenCodes.add(raw);
    candidates.push({
      vendor: vendor.name,
      code: raw,
      category: vendor.category,
      offerSummary: offerSummary(context, vendor, raw),
      redeemUrl: contextRedeemUrl ?? redemptionUrlFor(input.text, vendor),
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      repoFullName: input.repoFullName,
      sourceDate: input.sourceDate,
      confidence,
      expiresAt: parseExpiry(context, input.sourceDate) ?? parseExpiry(input.text, input.sourceDate),
      snippet: context,
      llmContext: cleanSnippetText(windowAround(input.text, index, match[0].length, 950)).slice(0, 2000)
    });
    if (candidates.length >= 8) break;
  }
  return { candidates, droppedReason: candidates.length ? undefined : 'stage3-no-plausible-code' };
}

function normalizeLlmConfidence(value: unknown): Confidence | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

export function extractJsonObject(value: string): string | null {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return null;
}

export function splitCodeList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]+|\s+(?:and|or)\s+/i)
    .map((part) => canonicalCode(part))
    .map((part) => part.replace(/^[-_]+|[-_]+$/g, ''))
    .filter(Boolean);
}

export function isSingleTokenCode(code: string): boolean {
  return /^[A-Z0-9][A-Z0-9_-]{4,31}$/.test(code);
}

export function parseLlmJson(value: string): ExtractedPromo | null {
  const json = extractJsonObject(value);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.is_public_promo !== true) return { isPublicPromo: false };
    const expiresRaw = typeof parsed.expires_at === 'string' ? parseExpiryDateValue(parsed.expires_at) : undefined;
    return {
      isPublicPromo: true,
      vendor: typeof parsed.vendor === 'string' ? parsed.vendor : undefined,
      code: typeof parsed.code === 'string' ? parsed.code.trim() : undefined,
      offerSummary: typeof parsed.offer_summary === 'string' ? cleanSnippetText(parsed.offer_summary) : undefined,
      redeemUrl: typeof parsed.redeem_url === 'string' ? sanitizeRedeemUrl(parsed.redeem_url) : undefined,
      expiresAt: expiresRaw,
      confidence: normalizeLlmConfidence(parsed.confidence)
    };
  } catch {
    return null;
  }
}

export function configuredLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.SARVAM_API_KEY) return 'sarvam';
  if (env.GEMINI_API_KEY) return 'gemini';
  return 'none';
}

export function configuredLlmModel(env: NodeJS.ProcessEnv = process.env): string {
  const provider = configuredLlmProvider(env);
  if (provider === 'openai') return env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
  if (provider === 'sarvam') return env.SARVAM_MODEL || SARVAM_DEFAULT_MODEL;
  if (provider === 'gemini') return env.GEMINI_MODEL || 'gemini-1.5-flash';
  return 'none';
}

async function emitLlmCall(context: LlmCallContext | undefined, record: ReturnType<typeof buildLlmUsageRecord>): Promise<void> {
  if (!context?.onCall) return;
  try {
    await context.onCall(record);
  } catch {
    // Usage persistence must not change the gate decision.
  }
}

export interface SarvamChatRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: false;
    temperature: number;
    reasoning_effort: 'low';
    max_tokens: number;
  };
}

function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function nextOpenAiTokenBudget(current: number): number {
  return Math.min(OPENAI_MAX_COMPLETION_TOKEN_CEILING, Math.max(current * 4, current + OPENAI_DEFAULT_MAX_COMPLETION_TOKENS));
}

export interface OpenAiChatRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    reasoning_effort: string;
    max_completion_tokens: number;
    response_format: {
      type: 'json_schema';
      json_schema: {
        name: 'public_promo_extraction';
        strict: true;
        schema: typeof PROMO_EXTRACTION_JSON_SCHEMA;
      };
    };
  };
}

export function buildOpenAiChatRequest(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  maxCompletionTokens = positiveIntEnv(env, 'OPENAI_MAX_COMPLETION_TOKENS', OPENAI_DEFAULT_MAX_COMPLETION_TOKENS)
): OpenAiChatRequest {
  const cappedTokens = Math.min(OPENAI_MAX_COMPLETION_TOKEN_CEILING, Math.max(256, Math.floor(maxCompletionTokens)));
  return {
    url: OPENAI_CHAT_COMPLETIONS_URL,
    timeoutMs: Math.max(5_000, positiveIntEnv(env, 'OPENAI_TIMEOUT_MS', OPENAI_DEFAULT_TIMEOUT_MS)),
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}`,
      'content-type': 'application/json'
    },
    body: {
      model: env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      reasoning_effort: env.OPENAI_REASONING_EFFORT || OPENAI_DEFAULT_REASONING_EFFORT,
      max_completion_tokens: cappedTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'public_promo_extraction',
          strict: true,
          schema: PROMO_EXTRACTION_JSON_SCHEMA
        }
      }
    }
  };
}

export function buildSarvamChatRequest(prompt: string, env: NodeJS.ProcessEnv = process.env): SarvamChatRequest {
  const apiKey = env.SARVAM_API_KEY ?? '';
  return {
    url: env.SARVAM_API_URL || SARVAM_DEFAULT_URL,
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: {
      model: env.SARVAM_MODEL || SARVAM_DEFAULT_MODEL,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0.1,
      reasoning_effort: 'low',
      max_tokens: SARVAM_MAX_TOKENS
    }
  };
}

function llmPrompt(text: string, vendors: VendorConfig[]): string {
  const vendorList = vendors.map((vendor) => `${vendor.name} (${vendor.domains.join(', ')})`).join('; ');
  return `Classify and extract the public promo in this text. Vendors: ${vendorList}.\n` +
    'Return exactly this JSON shape: {"is_public_promo":boolean,"vendor":string|null,"code":string|null,"offer_summary":string|null,"redeem_url":string|null,"expires_at":string|null,"confidence":"high"|"medium"|"low"}. ' +
    'Set is_public_promo=true only when the text intentionally shares a real, actionable public promo, coupon, or credit code for a SaaS, AI, or developer tool. ' +
    'Set is_public_promo=false for environment variable or identifier names (ELEVENLABS_API_KEY, DISCOUNT_CODE, *_ID, *_TOKEN, *_KEY, *_SECRET), placeholders (YOUR_CODE_HERE, PROMO123), CSS/UI tokens, and generic English or hyphenated phrases.\n\nText:\n' + text.slice(0, 6000);
}

interface LlmCallOutcome {
  content: string | null;
  failureReason?: string;
}

function retryDelayMs(attempt: number): number {
  return 250 * (attempt + 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function responseErrorSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').slice(0, 240);
  } catch {
    return 'unreadable error body';
  }
}

async function callSarvamDetailed(prompt: string, context?: LlmCallContext): Promise<LlmCallOutcome> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return { content: null, failureReason: 'missing-api-key' };
  const request = buildSarvamChatRequest(prompt);
  const model = request.body.model;
  let lastReason = 'unknown';
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const attemptNumber = attempt + 1;
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        const snippet = await responseErrorSnippet(response);
        lastReason = `http-${response.status}${snippet ? `: ${snippet}` : ''}`;
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'sarvam', model, attempt: attemptNumber, status: 'error', failureReason: lastReason
        }));
        if (attempt < 2 && transientHttpStatus(response.status)) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        return { content: null, failureReason: lastReason };
      }
      let body: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      try {
        body = await response.json() as typeof body;
      } catch {
        lastReason = 'invalid-json-response';
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'sarvam', model, attempt: attemptNumber, status: 'error', failureReason: lastReason
        }));
        if (attempt < 2) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        return { content: null, failureReason: lastReason };
      }
      const usage = parseProviderUsage(body);
      const choice = body.choices?.[0];
      const content = choice?.message?.content ?? '';
      const finishReason = choice?.finish_reason ?? usage.finishReason;
      if (finishReason === 'length') {
        lastReason = content.trim() ? 'finish-length-truncated-output' : 'finish-length-empty-content';
      } else if (!content.trim()) {
        lastReason = finishReason ? `empty-content-finish-${finishReason}` : 'empty-content-no-finish-reason';
      } else {
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'sarvam', model, attempt: attemptNumber, status: 'success', finishReason, usage
        }));
        return { content };
      }
      await emitLlmCall(context, buildLlmUsageRecord({
        provider: 'sarvam', model, attempt: attemptNumber, status: 'error', failureReason: lastReason, finishReason, usage
      }));
      if (attempt < 2) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      return { content: null, failureReason: lastReason };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : 'unknown';
      lastReason = name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)
        ? `timeout: ${message}`
        : `network-error: ${message}`;
      await emitLlmCall(context, buildLlmUsageRecord({
        provider: 'sarvam', model, attempt: attemptNumber, status: 'error', failureReason: lastReason
      }));
      if (attempt < 2) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      return { content: null, failureReason: lastReason };
    }
  }
  return { content: null, failureReason: lastReason };
}

async function callOpenAiDetailed(prompt: string, context?: LlmCallContext): Promise<LlmCallOutcome> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { content: null, failureReason: 'missing-api-key' };
  let maxTokens = positiveIntEnv(process.env, 'OPENAI_MAX_COMPLETION_TOKENS', OPENAI_DEFAULT_MAX_COMPLETION_TOKENS);
  let lastReason = 'unknown';
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const request = buildOpenAiChatRequest(prompt, process.env, maxTokens);
    const model = request.body.model;
    const attemptNumber = attempt + 1;
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs)
      });
      if (!response.ok) {
        const snippet = await responseErrorSnippet(response);
        lastReason = `http-${response.status}${snippet ? `: ${snippet}` : ''}`;
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'openai', model, attempt: attemptNumber, status: 'error', failureReason: lastReason
        }));
        if (attempt < 2 && transientHttpStatus(response.status)) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        return { content: null, failureReason: lastReason };
      }
      let body: {
        choices?: Array<{
          message?: { content?: string | null; refusal?: string | null };
          finish_reason?: string;
        }>;
      };
      try {
        body = await response.json() as typeof body;
      } catch {
        lastReason = 'invalid-json-response';
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'openai', model, attempt: attemptNumber, status: 'error', failureReason: lastReason
        }));
        if (attempt < 2) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        return { content: null, failureReason: lastReason };
      }
      const usage = parseProviderUsage(body);
      const choice = body.choices?.[0];
      const finishReason = choice?.finish_reason ?? usage.finishReason;
      const refusal = choice?.message?.refusal?.trim() ?? '';
      const content = choice?.message?.content ?? '';
      if (refusal && !content.trim()) {
        lastReason = `refusal: ${refusal.slice(0, 240)}`;
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'openai', model, attempt: attemptNumber, status: 'error', failureReason: lastReason, finishReason, usage
        }));
        return { content: null, failureReason: lastReason };
      }
      if (finishReason === 'content_filter') {
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'openai', model, attempt: attemptNumber, status: 'error', failureReason: 'content-filter', finishReason, usage
        }));
        return { content: null, failureReason: 'content-filter' };
      }
      if (content.trim() && parseLlmJson(content)) {
        await emitLlmCall(context, buildLlmUsageRecord({
          provider: 'openai', model, attempt: attemptNumber, status: 'success', finishReason, usage
        }));
        return { content };
      }
      if (finishReason === 'length') {
        lastReason = content.trim() ? 'finish-length-truncated-output' : 'finish-length-empty-content';
        maxTokens = nextOpenAiTokenBudget(request.body.max_completion_tokens);
      } else if (!content.trim()) {
        lastReason = finishReason ? `empty-content-finish-${finishReason}` : 'empty-content-no-finish-reason';
      } else {
        lastReason = 'unparseable-json-response';
      }
      await emitLlmCall(context, buildLlmUsageRecord({
        provider: 'openai', model, attempt: attemptNumber, status: 'error', failureReason: lastReason, finishReason, usage
      }));
      if (attempt < 2) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      return { content: null, failureReason: lastReason };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : 'unknown';
      lastReason = name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)
        ? `timeout: ${message}`
        : `network-error: ${message}`;
      await emitLlmCall(context, buildLlmUsageRecord({
        provider: 'openai', model, attempt: attemptNumber, status: 'error', failureReason: lastReason
      }));
      if (attempt < 2) {
        await delay(retryDelayMs(attempt));
        continue;
      }
      return { content: null, failureReason: lastReason };
    }
  }
  return { content: null, failureReason: lastReason };
}

async function callGemini(prompt: string, context?: LlmCallContext): Promise<LlmCallOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { content: null, failureReason: 'missing-api-key' };
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const failureReason = `http-${response.status}`;
      await emitLlmCall(context, buildLlmUsageRecord({
        provider: 'gemini', model, attempt: 1, status: 'error', failureReason
      }));
      return { content: null, failureReason };
    }
    const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const usage = parseProviderUsage(body);
    const content = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') || '';
    if (!content.trim()) {
      await emitLlmCall(context, buildLlmUsageRecord({
        provider: 'gemini', model, attempt: 1, status: 'error', failureReason: 'gemini-empty-or-error', usage
      }));
      return { content: null, failureReason: 'gemini-empty-or-error' };
    }
    await emitLlmCall(context, buildLlmUsageRecord({
      provider: 'gemini', model, attempt: 1, status: 'success', finishReason: usage.finishReason, usage
    }));
    return { content };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : 'unknown';
    const failureReason = name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)
      ? `timeout: ${message}`
      : `network-error: ${message}`;
    await emitLlmCall(context, buildLlmUsageRecord({
      provider: 'gemini', model, attempt: 1, status: 'error', failureReason
    }));
    return { content: null, failureReason };
  }
}

export interface LlmExtractionOutcome {
  result: ExtractedPromo | null;
  failureReason?: string;
}

/** Stage 3 pass 2 with provider failure detail for gate logging. */
export async function extractWithLlmDetailed(
  text: string,
  vendors: VendorConfig[],
  context?: LlmCallContext
): Promise<LlmExtractionOutcome> {
  const provider = configuredLlmProvider();
  if (provider === 'none') return { result: null, failureReason: 'unconfigured' };
  if (rejectSecrets(text).rejected) return { result: null, failureReason: 'rejected-secret-input' };
  if (isCryptoOrSpam({ text, vendors })) return { result: null, failureReason: 'rejected-crypto-or-spam-input' };
  const prompt = llmPrompt(text, vendors);
  if (provider === 'sarvam') {
    const outcome = await callSarvamDetailed(prompt, context);
    if (!outcome.content) return { result: null, failureReason: outcome.failureReason ?? 'empty-response' };
    const parsed = parseLlmJson(outcome.content);
    return parsed
      ? { result: parsed }
      : { result: null, failureReason: 'unparseable-json-response' };
  }
  if (provider === 'openai') {
    const outcome = await callOpenAiDetailed(prompt, context);
    if (!outcome.content) return { result: null, failureReason: outcome.failureReason ?? 'empty-response' };
    const parsed = parseLlmJson(outcome.content);
    return parsed
      ? { result: parsed }
      : { result: null, failureReason: 'unparseable-json-response' };
  }
  const outcome = await callGemini(prompt, context);
  if (!outcome.content) return { result: null, failureReason: outcome.failureReason ?? 'gemini-empty-or-error' };
  const parsed = parseLlmJson(outcome.content);
  return parsed ? { result: parsed } : { result: null, failureReason: 'gemini-unparseable-json-response' };
}

/** Stage 3 pass 2: optional low-cost LLM cleanup. Returns null when unconfigured or inconclusive. */
export async function extractWithLlm(text: string, vendors: VendorConfig[]): Promise<ExtractedPromo | null> {
  return (await extractWithLlmDetailed(text, vendors)).result;
}

/**
 * Apply Pass-2 LLM results.
 * An explicit rejection (`is_public_promo=false` or missing code) drops the candidate.
 * A null result is inconclusive: unconfigured callers may keep the Pass-1 candidate,
 * but a configured LLM gate must drop it instead of inserting unverified noise.
 */
function cleanLlmVendorName(raw: string | undefined): string | undefined {
  const cleaned = cleanSnippetText(raw ?? '').replace(/[.,;:!?)\]}>`'"]+$/g, '').trim();
  return cleaned ? cleaned.slice(0, 100) : undefined;
}

function invalidLlmVendorName(vendor: string | undefined): boolean {
  if (!vendor) return true;
  const normalized = vendor.trim().toLowerCase();
  return new Set(['unknown', 'null', 'none', 'n/a', 'na', 'modal', 'dialog', 'popup', 'button', 'banner', 'ui', 'coupon modal']).has(normalized);
}

function canonicalVendorMatch(vendorName: string, vendors: VendorConfig[]): VendorConfig | undefined {
  const key = normalizeVendorKey(vendorName);
  if (!key) return undefined;
  return vendors.find((vendor) => {
    const values = [vendor.name, vendor.id, ...vendor.keywords, ...vendor.domains];
    return values.some((value) => normalizeVendorKey(value) === key);
  });
}

function implausibleLlmCode(code: string): boolean {
  return !isSingleTokenCode(code) || isRejectedCodeToken(code) || STOPWORDS.has(code);
}

export function applyLlmExtraction(candidate: PromoCandidate, llm: ExtractedPromo | null, vendors: VendorConfig[]): PromoCandidate | null {
  if (!llm) return candidate;
  if (!llm.isPublicPromo || !llm.code) return null;
  const codes = splitCodeList(llm.code);
  if (codes.length !== 1 || implausibleLlmCode(codes[0])) return null;
  const llmVendorName = cleanLlmVendorName(llm.vendor);
  if (invalidLlmVendorName(llmVendorName)) return null;
  const context = `${candidate.llmContext ?? ''}\n${candidate.snippet}`.toLowerCase();
  if (llmVendorName?.toLowerCase() === 'github' && !/copilot|student developer pack|github education|education\.github\.com/.test(context)) return null;
  const canonical = canonicalVendorMatch(llmVendorName ?? '', vendors);
  return {
    ...candidate,
    vendor: canonical?.name ?? llmVendorName ?? candidate.vendor,
    code: codes[0],
    category: canonical?.category ?? candidate.category,
    offerSummary: llm.offerSummary ? cleanSnippetText(llm.offerSummary) : candidate.offerSummary,
    redeemUrl: sanitizeRedeemUrl(llm.redeemUrl) ?? candidate.redeemUrl,
    expiresAt: llm.expiresAt ?? candidate.expiresAt,
    confidence: llm.confidence ?? candidate.confidence
  };
}

export function expandLlmCandidates(candidate: PromoCandidate, llm: ExtractedPromo, vendors: VendorConfig[]): PromoCandidate[] {
  const codes = splitCodeList(llm.code);
  if (codes.length <= 1) {
    const applied = applyLlmExtraction(candidate, llm, vendors);
    return applied ? [applied] : [];
  }
  const expanded: PromoCandidate[] = [];
  for (const code of codes) {
    const applied = applyLlmExtraction(candidate, { ...llm, code }, vendors);
    if (applied) expanded.push(applied);
  }
  return expanded;
}

export interface LlmGateEvent {
  event: 'llm_gate_rejected' | 'llm_gate_failed';
  vendor: string;
  code: string;
  reason?: string;
}

/**
 * When an LLM provider is configured, every Pass-1 candidate must be validated
 * before insert. Rejections, empty/timed-out responses, and thrown errors all drop
 * the candidate. If no LLM is configured, Pass-1 candidates are returned unchanged.
 */
export async function enrichAndGateCandidates(
  candidates: PromoCandidate[],
  vendors: VendorConfig[],
  onEvent?: (event: string, details: Record<string, unknown>) => void,
  context?: LlmCallContext
): Promise<PromoCandidate[]> {
  if (configuredLlmProvider() === 'none') return candidates;
  const enriched: PromoCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const outcome = await extractWithLlmDetailed(candidate.llmContext ?? candidate.snippet, vendors, context);
      const llm = outcome.result;
      if (!llm) {
        onEvent?.('llm_gate_failed', { vendor: candidate.vendor, code: candidate.code, reason: outcome.failureReason ?? 'unknown' });
        continue;
      }
      const applied = expandLlmCandidates(candidate, llm, vendors);
      if (!applied.length) {
        onEvent?.('llm_gate_rejected', {
          vendor: candidate.vendor,
          code: candidate.code,
          reason: llm.isPublicPromo ? 'invalid-code-or-vendor' : 'not-public-promo'
        });
        continue;
      }
      onEvent?.('llm_gate_accepted', { vendor: candidate.vendor, code: candidate.code, accepted: applied.length });
      enriched.push(...applied);
    } catch (error) {
      onEvent?.('llm_gate_failed', {
        vendor: candidate.vendor,
        code: candidate.code,
        reason: error instanceof Error ? error.message : 'unknown'
      });
    }
  }
  return enriched;
}
