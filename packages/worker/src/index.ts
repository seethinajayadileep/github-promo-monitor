import {
  GitHubClient,
  applyDailyExpiry,
  buildCodeSearchQueries,
  buildSearchQueries,
  configuredLlmModel,
  configuredLlmProvider,
  createPool,
  insertGithubRateEvent,
  pruneScanRuns,
  publicExaSettings,
  sanitizePublicWorkerConfig,
  upsertWorkerRuntime
} from '@promo/shared';
import { config, loadVendors, loadWatchlist } from './config.js';
import { scanExaLane } from './exaLane.js';
import { STATIC_WATCHLIST_COMMIT_PAGE_SIZE, scanFastLane, scanHistoricalBackfill, scanSlowLane, scanWatchlist, type PollerOptions } from './poller.js';

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
  const github = new GitHubClient(process.env, {
    onRateLimit: (event) => {
      void insertGithubRateEvent(pool, event).catch((error) => {
        log('rate_event_persist_failed', { error: error instanceof Error ? error.message : 'unknown' });
      });
    }
  });
  const options: PollerOptions = { pool, github, vendors, watchlist };
  const exa = publicExaSettings();

  const reportRuntime = async () => {
    await upsertWorkerRuntime(pool, {
      llmProvider: configuredLlmProvider(),
      llmModel: configuredLlmModel(),
      config: sanitizePublicWorkerConfig({
        fastLaneIntervalMs: config.fastLaneIntervalMs,
        slowLaneIntervalMs: config.slowLaneIntervalMs,
        watchlistIntervalMs: config.watchlistIntervalMs,
        backfillIntervalMs: config.backfillIntervalMs,
        searchPageSize: config.searchPageSize,
        backfillEnabled: config.backfillEnabled,
        backfillDaysPerWindow: config.backfillDaysPerWindow,
        backfillMinimumRateLimitPercent: config.minimumRateLimitPercent,
        liveMinimumRateLimitPercent: config.liveMinimumRateLimitPercent,
        backfillStopDate: config.backfillStopDate,
        backfillStartDate: process.env.BACKFILL_START_DATE || null,
        maxCommitDetailsPerScan: config.maxCommitDetailsPerScan,
        maxCodeFilesPerScan: config.maxCodeFilesPerScan,
        maxCommitSearchPages: config.maxCommitSearchPages,
        maxIssueSearchPages: config.maxIssueSearchPages,
        maxCodeSearchPages: config.maxCodeSearchPages,
        liveCommitWindowDays: config.liveCommitWindowDays,
        maxFollowedReposPerScan: config.maxFollowedReposPerScan,
        followedRepoCommitPageSize: config.followedRepoCommitPageSize,
        maxFollowedCommitDetailsPerRepo: config.maxFollowedCommitDetailsPerRepo,
        maxFollowedCommitDetailsPerScan: config.maxFollowedCommitDetailsPerScan,
        scanRunRetentionDays: config.scanRunRetentionDays,
        searchQueryCount: buildSearchQueries(vendors).length,
        codeQueryCount: buildCodeSearchQueries(vendors).length,
        vendorCount: vendors.length,
        watchlistCount: watchlist.length,
        githubTokenCount: github.tokenPool.size,
        staticWatchlistCommitPageSize: STATIC_WATCHLIST_COMMIT_PAGE_SIZE,
        llmProvider: configuredLlmProvider(),
        llmModel: configuredLlmModel(),
        exaConfigured: exa.configured,
        exaSearchType: exa.type,
        exaIntervalMs: exa.intervalMs,
        exaNumResults: exa.numResults,
        exaMaxAgeHours: exa.maxAgeHours,
        exaPublishedWithinDays: exa.publishedWithinDays,
        exaQueryCount: vendors.length,
        exaTimeoutMs: exa.timeoutMs
      })
    });
  };

  if (!github.tokenPool.size) {
    log('github_token_missing', { detail: 'running unauthenticated; low GitHub limits apply' });
  }
  log('worker_started', {
    vendors: vendors.length,
    watchlistRepos: watchlist.length,
    fastLaneIntervalMs: config.fastLaneIntervalMs,
    slowLaneIntervalMs: config.slowLaneIntervalMs,
    tokenCount: github.tokenPool.size,
    llmProvider: configuredLlmProvider(),
    searchPageSize: config.searchPageSize,
    maxCommitSearchPages: config.maxCommitSearchPages,
    maxIssueSearchPages: config.maxIssueSearchPages,
    maxCodeSearchPages: config.maxCodeSearchPages,
    liveCommitWindowDays: config.liveCommitWindowDays,
    exaConfigured: exa.configured,
    exaSearchType: exa.type,
    exaIntervalMs: exa.intervalMs
  });

  try {
    await reportRuntime();
  } catch (error) {
    log('worker_runtime_persist_failed', { error: error instanceof Error ? error.message : 'unknown' });
  }

  const dailyExpiry = async () => {
    const result = await applyDailyExpiry(pool);
    const prunedScanRuns = await pruneScanRuns(pool, config.scanRunRetentionDays);
    try {
      await reportRuntime();
    } catch (error) {
      log('worker_runtime_persist_failed', { error: error instanceof Error ? error.message : 'unknown' });
    }
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
    lanes.push(laneLoop('historical-backfill', config.backfillIntervalMs, () => scanHistoricalBackfill(options), 60_000));
  }
  if (exa.configured) {
    lanes.push(laneLoop('exa', exa.intervalMs, () => scanExaLane(options), 60_000));
  } else {
    log('exa_lane_skipped', { reason: 'not-configured' });
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
