import { canonicalCode } from './dedupe.js';
import { rejectSecrets } from './secrets.js';
import { isCryptoOrSpam } from './spam.js';
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
  'MAKE-PROMO-CODE'
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
export const SARVAM_MAX_TOKENS = 1536;

const LLM_SYSTEM_PROMPT = 'Extract only intentionally public, actionable SaaS/AI/developer-tool promotional, coupon, or credit codes a person can redeem. Never output credentials. Reject environment-variable and identifier names (ELEVENLABS_API_KEY, DISCOUNT_CODE, ADMIN_ACCESS_TOKEN, or tokens ending in _ID, _TOKEN, _KEY, _SECRET, _CODE), placeholder strings (YOUR_CODE_HERE, PROMO123), CSS/UI tokens, license IDs, CVEs, and generic English or hyphenated tech phrases (CROSS-BROWSER, STEP-BY-STEP, OPEN-SOURCE, SINGLE-FILE). Return strict JSON.';

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

function matchingVendor(text: string, vendors: VendorConfig[]): VendorConfig | undefined {
  const lower = text.toLowerCase();
  return vendors.find((vendor) => vendorTerms(vendor).some((term) => term && lower.includes(term)));
}

function matchingVendorByUrl(text: string, vendors: VendorConfig[]): VendorConfig | undefined {
  const lower = text.toLowerCase();
  return vendors.find((vendor) => vendor.domains.some((domain) => lower.includes(domain.toLowerCase())));
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
  return urls.find((url) => vendor.domains.some((domain) => url.toLowerCase().includes(domain.toLowerCase())));
}

function parseExpiry(text: string): Date | undefined {
  const expiryContext = /(?:expires?|valid(?: until| through)?|ends?|before)\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;
  const match = text.match(expiryContext);
  if (!match) return undefined;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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

function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', index), text.lastIndexOf('.', index), index - 140);
  const endCandidates = [text.indexOf('\n', index + length), text.indexOf('.', index + length)];
  const positiveEnds = endCandidates.filter((value) => value >= 0);
  const end = positiveEnds.length ? Math.min(...positiveEnds) + 1 : Math.min(text.length, index + length + 180);
  return normalizeWhitespace(text.slice(start, end)).slice(0, 500);
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
      expiresAt: parseExpiry(context) ?? parseExpiry(input.text),
      snippet: context
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

export function parseLlmJson(value: string): ExtractedPromo | null {
  const json = extractJsonObject(value);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.is_public_promo !== true) return { isPublicPromo: false };
    const expiresRaw = typeof parsed.expires_at === 'string' ? new Date(parsed.expires_at) : undefined;
    return {
      isPublicPromo: true,
      vendor: typeof parsed.vendor === 'string' ? parsed.vendor : undefined,
      code: typeof parsed.code === 'string' ? canonicalCode(parsed.code) : undefined,
      offerSummary: typeof parsed.offer_summary === 'string' ? parsed.offer_summary : undefined,
      redeemUrl: typeof parsed.redeem_url === 'string' ? parsed.redeem_url : undefined,
      expiresAt: expiresRaw && !Number.isNaN(expiresRaw.getTime()) ? expiresRaw : undefined,
      confidence: normalizeLlmConfidence(parsed.confidence)
    };
  } catch {
    return null;
  }
}

export function configuredLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  if (env.SARVAM_API_KEY) return 'sarvam';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.GEMINI_API_KEY) return 'gemini';
  return 'none';
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

async function callSarvam(prompt: string): Promise<string | null> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return null;
  const request = buildSarvamChatRequest(prompt);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) return null;
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? null;
}

async function callOpenAi(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? null;
}

async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') || null;
}

/** Stage 3 pass 2: optional low-cost LLM cleanup. Returns null when unconfigured or inconclusive. */
export async function extractWithLlm(text: string, vendors: VendorConfig[]): Promise<ExtractedPromo | null> {
  if (configuredLlmProvider() === 'none') return null;
  if (rejectSecrets(text).rejected || isCryptoOrSpam({ text, vendors })) return null;
  const prompt = llmPrompt(text, vendors);
  const provider = configuredLlmProvider();
  const raw = provider === 'sarvam'
    ? await callSarvam(prompt)
    : provider === 'openai'
      ? await callOpenAi(prompt)
      : await callGemini(prompt);
  return raw ? parseLlmJson(raw) : null;
}

/**
 * Apply Pass-2 LLM results.
 * An explicit rejection (`is_public_promo=false` or missing code) drops the candidate.
 * A null result is inconclusive: unconfigured callers may keep the Pass-1 candidate,
 * but a configured LLM gate must drop it instead of inserting unverified noise.
 */
export function applyLlmExtraction(candidate: PromoCandidate, llm: ExtractedPromo | null, vendors: VendorConfig[]): PromoCandidate | null {
  if (!llm) return candidate;
  if (!llm.isPublicPromo || !llm.code) return null;
  const llmVendor = vendors.find((vendor) => vendor.name.toLowerCase() === llm.vendor?.toLowerCase() || vendor.id === llm.vendor?.toLowerCase());
  return {
    ...candidate,
    vendor: llmVendor?.name ?? candidate.vendor,
    code: canonicalCode(llm.code),
    category: llmVendor?.category ?? candidate.category,
    offerSummary: llm.offerSummary || candidate.offerSummary,
    redeemUrl: llm.redeemUrl || candidate.redeemUrl,
    expiresAt: llm.expiresAt ?? candidate.expiresAt,
    confidence: llm.confidence ?? candidate.confidence
  };
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
  onEvent?: (event: string, details: Record<string, unknown>) => void
): Promise<PromoCandidate[]> {
  if (configuredLlmProvider() === 'none') return candidates;
  const enriched: PromoCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const llm = await extractWithLlm(candidate.snippet, vendors);
      if (!llm) {
        onEvent?.('llm_gate_failed', { vendor: candidate.vendor, code: candidate.code, reason: 'empty-or-timeout' });
        continue;
      }
      const applied = applyLlmExtraction(candidate, llm, vendors);
      if (!applied) {
        onEvent?.('llm_gate_rejected', { vendor: candidate.vendor, code: candidate.code });
        continue;
      }
      enriched.push(applied);
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
