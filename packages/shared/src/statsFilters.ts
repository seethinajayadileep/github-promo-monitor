import { isIsoDate, istDateString, istDayStart, shiftIstDate } from './ist.js';

export const STATS_LANES = ['fast', 'slow', 'backfill', 'watchlist', 'followed'] as const;
export type StatsLane = (typeof STATS_LANES)[number];

export interface NormalizedStatsFilters {
  from: string;
  to: string;
  lane: StatsLane | '';
  model: string;
  q: string;
  start: Date;
  end: Date;
}

const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/;
const MAX_RANGE_DAYS = 366;

function cleanText(value: string | undefined, max: number): string {
  return (value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function normalizeStatsFilters(
  input: { from?: string; to?: string; lane?: string; model?: string; q?: string },
  now = new Date()
): NormalizedStatsFilters {
  const today = istDateString(now);
  let from = cleanText(input.from, 10);
  let to = cleanText(input.to, 10);
  if (!isIsoDate(from)) from = shiftIstDate(today, -6);
  if (!isIsoDate(to)) to = today;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  const earliest = shiftIstDate(to, -(MAX_RANGE_DAYS - 1));
  if (from < earliest) from = earliest;
  const lane = STATS_LANES.find((item) => item === cleanText(input.lane, 20)) ?? '';
  const modelRaw = cleanText(input.model, 64);
  const model = MODEL_PATTERN.test(modelRaw) && !/sk-|ghp_|gho_|github_pat_|bearer|api[_-]?key/i.test(modelRaw) ? modelRaw : '';
  const q = cleanText(input.q, 80);
  return {
    from,
    to,
    lane,
    model,
    q,
    start: istDayStart(from),
    end: istDayStart(shiftIstDate(to, 1))
  };
}
