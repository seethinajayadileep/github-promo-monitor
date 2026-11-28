/** GitHub Search will not open more than this many hits for one query. */
export const GITHUB_SEARCH_RESULT_CEILING = 1000;

export const STATS_HONESTY = {
  notAQueue: 'GitHub search is not a finite queue of unique repositories. A query\'s total_count is an estimate of matching documents, the same repository appears under many queries, and the number changes as GitHub indexes. This page does not turn that estimate into a count of repos left to scan.',
  reportedTotal: 'GitHub reported total_count is shown per query window only. It is not a count of unique repos and it is not subtracted from a global backlog.',
  unopened: 'Unopened hits are documents inside one query window that this scan did not open because the page cap or a rate limit stopped it. The searchable ceiling for one query is 1,000 hits. Hits above that ceiling were never available from the search API.',
  historicalTokens: 'Token totals include only LLM calls stored after usage logging shipped. Earlier calls were not stored, so historical input, output, cached tokens, and cost stay at zero until new calls run.',
  historicalScans: 'Page counts, GitHub reported totals, and cap flags are stored from scans that run after this version. Older retained scan rows leave those fields blank and are not treated as cap-saturated.',
  ist: 'All timestamps on this page use Asia/Kolkata (IST).',
  noSecrets: 'This page does not show API keys, GitHub tokens, prompts, or rejected snippet text.'
} as const;

export function laneFromQueryKey(queryKey: string): string {
  if (queryKey.startsWith('fast:')) return 'fast';
  if (queryKey.startsWith('slow:')) return 'slow';
  if (queryKey.startsWith('watchlist:')) return 'watchlist';
  if (queryKey.startsWith('followed:')) return 'followed';
  if (queryKey.startsWith('backfill:') || queryKey === 'backfill-window-complete') return 'backfill';
  if (queryKey.startsWith('exa:')) return 'exa';
  return 'other';
}

export function searchPageCapSaturated(input: {
  pagesScanned: number;
  maxPages: number;
  hitsFetched: number;
  reportedTotal: number;
  stoppedOnShortPage: boolean;
  pageFailed: boolean;
}): boolean {
  if (input.pageFailed || input.stoppedOnShortPage) return false;
  if (input.maxPages <= 0 || input.pagesScanned < input.maxPages) return false;
  const ceiling = Math.min(Math.max(0, input.reportedTotal), GITHUB_SEARCH_RESULT_CEILING);
  return input.hitsFetched < ceiling;
}

export function singlePageWasFull(hitsFetched: number, pageSize: number): boolean {
  return pageSize > 0 && hitsFetched >= pageSize;
}

export function unopenedSearchHits(input: {
  hitsFetched: number;
  reportedTotal: number | null;
  capSaturated: boolean;
  rateLimited: boolean;
}): { hits: number | null; reason: 'cap' | 'rate-limit' | null } {
  const stopped = input.capSaturated || input.rateLimited;
  if (!stopped || input.reportedTotal == null) return { hits: null, reason: null };
  const ceiling = Math.min(Math.max(0, input.reportedTotal), GITHUB_SEARCH_RESULT_CEILING);
  const hits = Math.max(0, ceiling - Math.max(0, Math.floor(input.hitsFetched)));
  if (input.capSaturated) return { hits, reason: 'cap' };
  return { hits, reason: 'rate-limit' };
}

export interface QueryCycleEstimate {
  queryCount: number;
  nextIndex: number | null;
  nextQueryNumber: number | null;
  queriesUntilWrap: number | null;
  nominalCycleMs: number | null;
  observedMedianGapMs: number | null;
  estimatedFullCycleMs: number | null;
  estimatedWrapMs: number | null;
  basis: 'observed-gap' | 'nominal-interval' | 'unavailable';
}

export function medianPositive(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function gapsBetweenIsoTimes(values: string[]): number[] {
  const times = values
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    gaps.push(times[index] - times[index - 1]);
  }
  return gaps;
}

export function estimateQueryCycle(input: {
  queryCount: number;
  nextIndex: number | null;
  intervalMs: number | null;
  observedGapsMs: number[];
}): QueryCycleEstimate {
  const queryCount = Math.max(0, Math.floor(input.queryCount));
  if (queryCount <= 0) {
    return {
      queryCount: 0,
      nextIndex: input.nextIndex,
      nextQueryNumber: null,
      queriesUntilWrap: null,
      nominalCycleMs: null,
      observedMedianGapMs: null,
      estimatedFullCycleMs: null,
      estimatedWrapMs: null,
      basis: 'unavailable'
    };
  }
  const nextIndex = input.nextIndex == null ? null : ((input.nextIndex % queryCount) + queryCount) % queryCount;
  const queriesUntilWrap = nextIndex == null ? null : nextIndex === 0 ? queryCount : queryCount - nextIndex;
  const observedMedianGapMs = medianPositive(input.observedGapsMs);
  const nominalCycleMs = input.intervalMs && input.intervalMs > 0 ? queryCount * input.intervalMs : null;
  const stepMs = observedMedianGapMs ?? (input.intervalMs && input.intervalMs > 0 ? input.intervalMs : null);
  const basis: QueryCycleEstimate['basis'] = observedMedianGapMs
    ? 'observed-gap'
    : stepMs
      ? 'nominal-interval'
      : 'unavailable';
  return {
    queryCount,
    nextIndex,
    nextQueryNumber: nextIndex == null ? null : nextIndex + 1,
    queriesUntilWrap,
    nominalCycleMs,
    observedMedianGapMs,
    estimatedFullCycleMs: stepMs == null ? null : queryCount * stepMs,
    estimatedWrapMs: stepMs == null || queriesUntilWrap == null ? null : queriesUntilWrap * stepMs,
    basis
  };
}

export function followedPassEstimate(total: number, perScan: number | null, intervalMs: number | null): {
  passes: number | null;
  durationMs: number | null;
} {
  if (perScan == null || perScan <= 0 || total < 0) return { passes: null, durationMs: null };
  const passes = Math.ceil(total / perScan);
  return { passes, durationMs: intervalMs && intervalMs > 0 ? passes * intervalMs : null };
}

export type LaneHealth = 'no-runs' | 'stale' | 'rate-limited' | 'cap-saturated' | 'ok';

export function laneHealth(input: {
  lastScanAt: string | null;
  intervalMs: number | null;
  capHits: number;
  rateLimitedRuns: number;
  now: Date;
}): LaneHealth {
  if (!input.lastScanAt) return 'no-runs';
  const age = input.now.getTime() - new Date(input.lastScanAt).getTime();
  if (input.intervalMs && input.intervalMs > 0 && age > input.intervalMs * 3) return 'stale';
  if (input.rateLimitedRuns > 0) return 'rate-limited';
  if (input.capHits > 0) return 'cap-saturated';
  return 'ok';
}
