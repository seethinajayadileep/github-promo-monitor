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

const STOPWORDS = new Set([
  'README', 'LICENSE', 'OPENAI', 'HTTPS', 'HTTP', 'API', 'JSON', 'HTML', 'CSS', 'SQL', 'TODO', 'MIT', 'Apache',
  'COPYING', 'CONTRIBUTING', 'GITHUB', 'PROMO', 'CODE', 'COUPON', 'CREDITS', 'FREE', 'REDEEM', 'DISCOUNT', 'OFFER',
  'HACKATHON', 'PARTNER', 'PERK', 'PERKS', 'STUDENT', 'CLAIM', 'VALID', 'BEFORE', 'AFTER', 'WITH', 'FROM', 'THIS', 'THAT',
  'TOKEN', 'SECRET', 'PASSWORD', 'BEARER', 'PRIVATE', 'PUBLIC', 'NODE', 'NPM', 'YARN', 'PNPM', 'ENV', 'TRUE', 'FALSE',
  'NULL', 'UNDEFINED', 'ERROR', 'WARNING', 'DEBUG', 'INFO', 'POST', 'GET', 'PUT', 'PATCH', 'DELETE'
]);

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

function matchingVendor(text: string, vendors: VendorConfig[]): VendorConfig | undefined {
  const lower = text.toLowerCase();
  return vendors.find((vendor) => {
    const terms = [vendor.name, ...vendor.keywords].map((term) => term.toLowerCase());
    return terms.some((term) => term && lower.includes(term));
  });
}

function matchingVendorByUrl(text: string, vendors: VendorConfig[]): VendorConfig | undefined {
  const lower = text.toLowerCase();
  return vendors.find((vendor) => vendor.domains.some((domain) => lower.includes(domain.toLowerCase())));
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

function isPlausibleCode(raw: string, original: string, stopwords: Set<string>): boolean {
  if (raw.length < 5 || raw.length > 32) return false;
  if (stopwords.has(raw) || STOPWORDS.has(raw)) return false;
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
  const vendorMentioned = [vendor.name, ...vendor.keywords].some((term) => lower.includes(term.toLowerCase()));
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

  const vendor = matchingVendor(input.text, input.vendors) ?? matchingVendorByUrl(input.text, input.vendors);
  if (!vendor) return { candidates: [], droppedReason: 'stage3-no-target-vendor-or-redemption-url' };

  const vendorWords = vendorStopwords(input.vendors);
  const candidates: PromoCandidate[] = [];
  const seenCodes = new Set<string>();
  for (const match of input.text.matchAll(CODE_PATTERN)) {
    const raw = cleanCode(match[0]);
    if (!isPlausibleCode(raw, match[0], vendorWords) || seenCodes.has(raw)) continue;
    const context = sentenceAround(input.text, match.index ?? 0, match[0].length);
    const contextLower = context.toLowerCase();
    if (!hasPublicSharingCue(contextLower)) continue;
    const redeemUrl = redemptionUrlFor(context, vendor) ?? redemptionUrlFor(input.text, vendor);
    const confidence = scoreConfidence(context, vendor, redeemUrl);
    if (confidence === 'low' && !redeemUrl) continue;
    seenCodes.add(raw);
    candidates.push({
      vendor: vendor.name,
      code: raw,
      category: vendor.category,
      offerSummary: offerSummary(context, vendor, raw),
      redeemUrl,
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

function parseLlmJson(value: string): ExtractedPromo | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
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
        { role: 'system', content: 'Extract only intentionally public SaaS/AI/developer-tool promotional codes. Never output credentials. Return strict JSON.' },
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
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) return null;
  if (rejectSecrets(text).rejected || isCryptoOrSpam({ text, vendors })) return null;
  const vendorList = vendors.map((vendor) => `${vendor.name} (${vendor.domains.join(', ')})`).join('; ');
  const prompt = `Classify and extract the public promo in this text. Vendors: ${vendorList}.\n` +
    'Return exactly this JSON shape: {"is_public_promo":boolean,"vendor":string|null,"code":string|null,"offer_summary":string|null,"redeem_url":string|null,"expires_at":string|null,"confidence":"high"|"medium"|"low"}. ' +
    'Set is_public_promo=false unless the text intentionally shares a public promo/coupon/credit code for a SaaS, AI, or developer tool.\n\nText:\n' + text.slice(0, 6000);
  const raw = process.env.OPENAI_API_KEY ? await callOpenAi(prompt) : await callGemini(prompt);
  return raw ? parseLlmJson(raw) : null;
}

export function applyLlmExtraction(candidate: PromoCandidate, llm: ExtractedPromo | null, vendors: VendorConfig[]): PromoCandidate {
  if (!llm?.isPublicPromo || !llm.code) return candidate;
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
