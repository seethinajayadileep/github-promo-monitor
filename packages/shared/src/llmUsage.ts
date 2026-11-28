export const GPT6_LUNA_INPUT_USD_PER_MILLION = 0.1;
export const GPT6_LUNA_OUTPUT_USD_PER_MILLION = 0.5;

export type LlmCallStatus = 'success' | 'timeout' | 'error';

export interface ParsedProviderUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  finishReason: string | null;
}

export interface LlmUsageRecord {
  provider: 'sarvam' | 'openai' | 'gemini';
  model: string;
  status: LlmCallStatus;
  finishReason: string | null;
  failureCode: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  attempt: number;
  costUsd: number;
  costEstimated: boolean;
}

export interface LlmCallContext {
  onCall?: (record: LlmUsageRecord) => void | Promise<void>;
}

export interface LlmCostEstimate {
  usd: number;
  priced: boolean;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedPerMillion: number | null;
}

const EMPTY_USAGE: ParsedProviderUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  finishReason: null
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * Read token counts from an OpenAI-compatible chat body or a Gemini usageMetadata body.
 * Cached tokens are whatever the provider reported; this does not treat them as a subset.
 */
export function parseProviderUsage(body: unknown): ParsedProviderUsage {
  const root = asRecord(body);
  if (!root) return { ...EMPTY_USAGE };
  const gemini = asRecord(root.usageMetadata);
  if (gemini) {
    const candidate = Array.isArray(root.candidates) ? asRecord(root.candidates[0]) : null;
    const finish = candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason.slice(0, 40) : null;
    return {
      promptTokens: nonNegativeInt(gemini.promptTokenCount),
      completionTokens: nonNegativeInt(gemini.candidatesTokenCount),
      cachedTokens: nonNegativeInt(gemini.cachedContentTokenCount),
      finishReason: finish
    };
  }
  const usage = asRecord(root.usage) ?? {};
  const promptDetails = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details) ?? {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason.slice(0, 40) : null;
  return {
    promptTokens: nonNegativeInt(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: nonNegativeInt(usage.completion_tokens ?? usage.output_tokens),
    cachedTokens: nonNegativeInt(promptDetails.cached_tokens ?? usage.cached_tokens ?? usage.cache_read_input_tokens),
    finishReason
  };
}

export function estimateLlmCostUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number }
): LlmCostEstimate {
  const key = model.trim().toLowerCase();
  const prompt = Math.max(0, Math.floor(usage.promptTokens));
  const completion = Math.max(0, Math.floor(usage.completionTokens));
  const cached = Math.max(0, Math.floor(usage.cachedTokens));
  if (key === 'gpt-6-luna' || key.startsWith('gpt-6-luna-') || key.startsWith('gpt-6-luna/')) {
    // OpenAI reports cached tokens inside prompt_tokens. Cap the cached slice so it is not billed twice.
    const cachedSlice = Math.min(cached, prompt);
    const uncached = prompt - cachedSlice;
    const raw = (
      uncached * GPT6_LUNA_INPUT_USD_PER_MILLION
      + cachedSlice * GPT6_LUNA_INPUT_USD_PER_MILLION
      + completion * GPT6_LUNA_OUTPUT_USD_PER_MILLION
    ) / 1_000_000;
    return {
      usd: Math.round(raw * 1e8) / 1e8,
      priced: true,
      inputPerMillion: GPT6_LUNA_INPUT_USD_PER_MILLION,
      outputPerMillion: GPT6_LUNA_OUTPUT_USD_PER_MILLION,
      cachedPerMillion: GPT6_LUNA_INPUT_USD_PER_MILLION
    };
  }
  return { usd: 0, priced: false, inputPerMillion: null, outputPerMillion: null, cachedPerMillion: null };
}

export interface LlmRateCardEntry {
  model: string;
  priced: boolean;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedPerMillion: number | null;
  note: string;
}

export function llmRateCard(): LlmRateCardEntry[] {
  return [
    {
      model: 'gpt-6-luna',
      priced: true,
      inputPerMillion: GPT6_LUNA_INPUT_USD_PER_MILLION,
      outputPerMillion: GPT6_LUNA_OUTPUT_USD_PER_MILLION,
      cachedPerMillion: GPT6_LUNA_INPUT_USD_PER_MILLION,
      note: 'Input $0.10 per million tokens, output $0.50 per million. Cached input tokens are billed at the input rate; no separate cached discount is configured.'
    },
    {
      model: 'sarvam-105b',
      priced: false,
      inputPerMillion: null,
      outputPerMillion: null,
      cachedPerMillion: null,
      note: 'Requests and token counts are stored. No dollar rate is configured, so these calls are excluded from estimated cost.'
    }
  ];
}

const KNOWN_FAILURE_CODES = [
  'finish-length-truncated-output',
  'finish-length-empty-content',
  'empty-content-no-finish-reason',
  'unparseable-json-response',
  'invalid-json-response',
  'content-filter',
  'missing-api-key',
  'rejected-secret-input',
  'rejected-crypto-or-spam-input',
  'gemini-empty-or-error',
  'gemini-unparseable-json-response',
  'empty-response',
  'unconfigured',
  'network-error'
] as const;

/** Map a provider error into a short code. Response bodies and secrets are not kept. */
export function classifyLlmFailure(reason: string | undefined): { status: 'timeout' | 'error'; code: string } {
  if (!reason) return { status: 'error', code: 'unknown' };
  const lower = reason.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborterror')) {
    return { status: 'timeout', code: 'timeout' };
  }
  if (lower.startsWith('refusal')) return { status: 'error', code: 'refusal' };
  for (const code of KNOWN_FAILURE_CODES) {
    if (lower.startsWith(code) || lower.includes(code)) return { status: 'error', code };
  }
  if (lower.startsWith('empty-content-finish-')) {
    const code = reason.split(':')[0].slice(0, 80).replace(/[^a-z0-9-]/gi, '');
    return { status: 'error', code: code || 'empty-content' };
  }
  const http = reason.match(/http-(\d{3})/i);
  if (http) return { status: 'error', code: `http-${http[1]}` };
  return { status: 'error', code: 'request-failed' };
}

export function buildLlmUsageRecord(
  base: {
    provider: LlmUsageRecord['provider'];
    model: string;
    attempt: number;
    status: LlmCallStatus;
    failureReason?: string;
    finishReason?: string | null;
    usage?: ParsedProviderUsage;
  }
): LlmUsageRecord {
  const usage = base.usage ?? EMPTY_USAGE;
  const classified = base.status === 'success' ? null : classifyLlmFailure(base.failureReason);
  const status: LlmCallStatus = classified?.status === 'timeout' ? 'timeout' : base.status;
  const cost = estimateLlmCostUsd(base.model, usage);
  return {
    provider: base.provider,
    model: base.model.slice(0, 80),
    status,
    finishReason: base.finishReason ?? usage.finishReason,
    failureCode: classified?.code ?? null,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    attempt: Math.max(1, Math.floor(base.attempt)),
    costUsd: cost.usd,
    costEstimated: cost.priced
  };
}
