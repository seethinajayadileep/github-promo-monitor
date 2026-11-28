import { GitHubClient, applyDailyExpiry, configuredLlmProvider, createPool, pruneScanRuns } from '@promo/shared';
import { config, loadVendors, loadWatchlist } from './config.js';
import { scanFastLane, scanHistoricalBackfill, scanSlowLane, scanWatchlist, type PollerOptions } from './poller.js';

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSafely(name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    log('scan_complete', { lane: name });
  } catch (error) {
    log('scan_failed', { lane: name, error: error instanceof Error ? error.message : 'unknown' });
  }
}

async function laneLoop(name: string, intervalMs: number, task: () => Promise<void>, jitterMs = 5_000): Promise<void> {
  const jitter = Math.floor(Math.random() * jitterMs);
  await sleep(jitter);
  for (;;) {
    const started = Date.now();
    await runSafely(name, task);
    const elapsed = Date.now() - started;
    await sleep(Math.max(1_000, intervalMs - elapsed));
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  const vendors = loadVendors();
  const watchlist = loadWatchlist();
  const github = new GitHubClient();
  const options: PollerOptions = { pool, github, vendors, watchlist };

  if (!github.tokenPool.size) {
    log('github_token_missing', { detail: 'running unauthenticated; low GitHub limits apply' });
  }
  log('worker_started', {
    vendors: vendors.length,
    watchlistRepos: watchlist.length,
    fastLaneIntervalMs: config.fastLaneIntervalMs,
    slowLaneIntervalMs: config.slowLaneIntervalMs,
    tokenCount: github.tokenPool.size,
    llmProvider: configuredLlmProvider()
  });

  const dailyExpiry = async () => {
    const result = await applyDailyExpiry(pool);
    const prunedScanRuns = await pruneScanRuns(pool, config.scanRunRetentionDays);
    log('daily_expiry_complete', { ...result, prunedScanRuns });
  };
  await runSafely('daily-expiry', dailyExpiry);

  const lanes = [
    laneLoop('fast', config.fastLaneIntervalMs, () => scanFastLane(options)),
    laneLoop('slow', config.slowLaneIntervalMs, () => scanSlowLane(options), 30_000),
    laneLoop('watchlist', config.watchlistIntervalMs, () => scanWatchlist(options)),
    laneLoop('daily-expiry', 24 * 60 * 60 * 1000, dailyExpiry, 60_000)
  ];
  if (config.backfillEnabled) {
    lanes.push(laneLoop('historical-backfill', 30 * 60 * 1000, () => scanHistoricalBackfill(options), 60_000));
  }
  await Promise.all(lanes);
}

process.on('unhandledRejection', (error) => {
  log('unhandled_rejection', { error: error instanceof Error ? error.message : 'unknown' });
});
process.on('SIGTERM', () => {
  log('shutdown_signal', { signal: 'SIGTERM' });
  process.exit(0);
});
process.on('SIGINT', () => {
  log('shutdown_signal', { signal: 'SIGINT' });
  process.exit(0);
});

main().catch((error) => {
  log('worker_fatal', { error: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
});
