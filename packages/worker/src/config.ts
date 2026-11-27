import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VendorConfig, WatchlistRepo } from '@promo/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')) as T;
}

export function loadVendors(): VendorConfig[] {
  return readJson<VendorConfig[]>('vendors.json');
}

export function loadWatchlist(): WatchlistRepo[] {
  return readJson<WatchlistRepo[]>('watchlist.json');
}

export function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  fastLaneIntervalMs: numberEnv('FAST_LANE_INTERVAL_MS', 90_000),
  slowLaneIntervalMs: numberEnv('SLOW_LANE_INTERVAL_MS', 1_200_000),
  watchlistIntervalMs: numberEnv('WATCHLIST_INTERVAL_MS', 300_000),
  searchPageSize: numberEnv('SEARCH_PAGE_SIZE', 30),
  backfillEnabled: (process.env.BACKFILL_ENABLED ?? 'true').toLowerCase() === 'true',
  backfillDaysPerWindow: numberEnv('BACKFILL_DAYS_PER_WINDOW', 7),
  minimumRateLimitPercent: numberEnv('BACKFILL_MINIMUM_RATE_LIMIT_PERCENT', 30),
  liveMinimumRateLimitPercent: numberEnv('LIVE_MINIMUM_RATE_LIMIT_PERCENT', 3),
  backfillStopDate: process.env.BACKFILL_STOP_DATE || '2020-01-01',
  maxCommitDetailsPerScan: numberEnv('MAX_COMMIT_DETAILS_PER_SCAN', 3),
  maxCodeFilesPerScan: numberEnv('MAX_CODE_FILES_PER_SCAN', 3)
};
