import { afterEach, describe, expect, it } from 'vitest';
import {
  applyLlmExtraction,
  buildSarvamChatRequest,
  configuredLlmProvider,
  extractPassOne,
  extractWithLlm,
  isRejectedCodeToken,
  parseLlmJson,
  SARVAM_DEFAULT_MODEL,
  SARVAM_DEFAULT_URL,
  SARVAM_MAX_TOKENS
} from '../src/extractor.js';
import type { PromoCandidate, VendorConfig } from '../src/types.js';

const vendors: VendorConfig[] = [
  { id: 'openai', name: 'OpenAI', category: 'ai', domains: ['openai.com', 'platform.openai.com'], keywords: ['OpenAI', 'ChatGPT'] },
  { id: 'firecrawl', name: 'Firecrawl', category: 'developer-tools', domains: ['firecrawl.dev'], keywords: ['Firecrawl'] },
  { id: 'apify', name: 'Apify', category: 'developer-tools', domains: ['apify.com'], keywords: ['Apify'] }
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

const sampleCandidate: PromoCandidate = {
  vendor: 'Apify',
  code: 'BSD-3-CLAUSE',
  category: 'developer-tools',
  offerSummary: 'Mentioned near a docs URL',
  sourceUrl: 'https://github.com/example/repo/blob/main/README.md',
  sourceType: 'code',
  repoFullName: 'example/repo',
  confidence: 'low',
  snippet: 'Licensed under BSD-3-CLAUSE. See https://apify.com/docs'
};

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

  it('rejects license IDs, CVEs, and generic tech/prose compounds', () => {
    const rejected = [
      'BSD-3-CLAUSE', 'MIT-LICENSE', 'APACHE-2.0', 'CVE-2026-12345',
      'TIME-LIMITED', 'SELF-HOSTED', 'OPEN-SOURCE', 'REAL-TIME', 'END-TO-END',
      'UTF-8', 'SHA-256', 'HTTP-CACHE'
    ];
    for (const token of rejected) {
      expect(isRejectedCodeToken(token), token).toBe(true);
    }
    const text = [
      'Use code BSD-3-CLAUSE for OpenAI credits.',
      'Use code TIME-LIMITED for OpenAI credits.',
      'Use code CVE-2026-12345 for OpenAI credits.',
      'Use code SHA-256 for OpenAI credits.',
      'Use code HTTP-CACHE for OpenAI credits.',
      'Use code SELF-HOSTED for OpenAI credits at https://platform.openai.com/'
    ].join('\n');
    expect(extract(text).candidates.map((item) => item.code)).toEqual([]);
  });

  it('requires vendor proximity around the candidate code', () => {
    const farVendor = `${'Notes about an unrelated TIME window.\n'.repeat(20)}Use code FARAWAY2025 to redeem credits.\n\n${'padding line\n'.repeat(20)}OpenAI documentation lives at https://platform.openai.com/`;
    expect(extract(farVendor).candidates.map((item) => item.code)).not.toContain('FARAWAY2025');

    const nearby = 'Use code NEARBY2025 for OpenAI free credits.';
    expect(extract(nearby).candidates.map((item) => item.code)).toContain('NEARBY2025');
  });

  it('drops low-confidence hits that only matched a docs URL without a nearby promo signal', () => {
    const text = 'RANDOMCODE appears in this paragraph about logging.\n\nSee the OpenAI docs at https://platform.openai.com/docs for details.';
    expect(extract(text).candidates.map((item) => item.code)).not.toContain('RANDOMCODE');
  });
});

describe('LLM extraction helpers', () => {
  afterEach(() => {
    delete process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_URL;
    delete process.env.SARVAM_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('builds a non-streaming Sarvam payload with subscription-key auth and enough max_tokens', () => {
    process.env.SARVAM_API_KEY = 'test-key';
    const request = buildSarvamChatRequest('hello');
    expect(request.url).toBe(SARVAM_DEFAULT_URL);
    expect(request.headers['api-subscription-key']).toBe('test-key');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      model: SARVAM_DEFAULT_MODEL,
      stream: false,
      temperature: 0.1,
      reasoning_effort: 'low',
      max_tokens: SARVAM_MAX_TOKENS
    });
    expect(request.body.max_tokens).toBeGreaterThanOrEqual(1536);
    expect(configuredLlmProvider()).toBe('sarvam');
    process.env.OPENAI_API_KEY = 'openai-key';
    expect(configuredLlmProvider()).toBe('sarvam');
  });

  it('parses JSON even when wrapped in fences or preceded by reasoning text', () => {
    const json = '{"is_public_promo":true,"vendor":"Apify","code":"APIFY_CAL_HACKS","offer_summary":"$200 in free Apify credits","redeem_url":null,"expires_at":"2026-12-31","confidence":"high"}';
    expect(parseLlmJson('```json\n' + json + '\n```')).toMatchObject({
      isPublicPromo: true,
      vendor: 'Apify',
      code: 'APIFY_CAL_HACKS',
      confidence: 'high'
    });
    expect(parseLlmJson('Thinking about the snippet...\n' + json)).toMatchObject({
      isPublicPromo: true,
      code: 'APIFY_CAL_HACKS'
    });
    expect(parseLlmJson('{"is_public_promo":false,"vendor":null,"code":null}')).toEqual({ isPublicPromo: false });
  });

  it('drops candidates when the LLM rejects a false positive or returns no code', () => {
    expect(applyLlmExtraction(sampleCandidate, { isPublicPromo: false }, vendors)).toBeNull();
    expect(applyLlmExtraction(sampleCandidate, { isPublicPromo: true }, vendors)).toBeNull();
    const kept = applyLlmExtraction(sampleCandidate, null, vendors);
    expect(kept?.code).toBe('BSD-3-CLAUSE');
    const promoted = applyLlmExtraction(sampleCandidate, {
      isPublicPromo: true,
      vendor: 'Apify',
      code: 'APIFY_CAL_HACKS',
      offerSummary: '$200 in free Apify credits',
      confidence: 'high'
    }, vendors);
    expect(promoted).toMatchObject({ vendor: 'Apify', code: 'APIFY_CAL_HACKS', confidence: 'high' });
  });

  it('calls Sarvam and drops a rejected false positive from extractWithLlm', async () => {
    process.env.SARVAM_API_KEY = 'test-key';
    const payloads: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)));
      const headers = init?.headers as Record<string, string>;
      expect(headers['api-subscription-key']).toBe('test-key');
      expect(headers.authorization ?? headers.Authorization).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"is_public_promo":false,"vendor":null,"code":null,"offer_summary":null,"redeem_url":null,"expires_at":null,"confidence":"low"}' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const llm = await extractWithLlm('Licensed under BSD-3-CLAUSE. See the OpenAI docs.', vendors);
      expect(llm).toEqual({ isPublicPromo: false });
      expect(applyLlmExtraction(sampleCandidate, llm, vendors)).toBeNull();
      expect(payloads[0]).toMatchObject({ model: 'sarvam-105b', stream: false, reasoning_effort: 'low', max_tokens: 1536 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
