import {
  BACKFILL_WINDOW_COMPLETE_KEY,
  GitHubClient,
  addCommitDateWindow,
  addIssueQualifier,
  addRecentCommitDateWindow,
  advanceLaneCursor,
  buildCodeSearchQueries,
  buildSearchQueries,
  dedupeCandidates,
  encodeQuery,
  enrichAndGateCandidates,
  extractPassOne,
  getLaneCursor,
  insertScanRun,
  latestBackfillWindow,
  latestEtag,
  notifyAll,
  upsertPromoCandidate,
  type PromoCandidate,
  type RateLimitState,
  type ScanMode,
  type SourceType,
  type VendorConfig,
  type WatchlistRepo
} from '@promo/shared';
import type pg from 'pg';
import { config } from './config.js';
import type {
  CodeSearchItem,
  CommitDetail,
  CommitSearchItem,
  IssueSearchItem,
  RepoCommitListItem,
  SearchResponse
} from './types.js';

export interface PollerOptions {
  pool: pg.Pool;
  github: GitHubClient;
  vendors: VendorConfig[];
  watchlist: WatchlistRepo[];
}

interface IngestResult {
  hitsFound: number;
  newCodes: number;
  rateLimitRemaining?: number;
  etag?: string;
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function repoFromRepositoryUrl(repositoryUrl?: string): string {
  if (!repositoryUrl) return 'unknown/unknown';
  const parts = repositoryUrl.split('/repos/');
  return parts[1] ?? 'unknown/unknown';
}

function dateOrUndefined(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function rateLimitFields(rateLimit: RateLimitState): { rateLimitRemaining?: number; rateLimitLimit?: number; rateLimitResource?: string } {
  return {
    rateLimitRemaining: rateLimit.remaining,
    rateLimitLimit: rateLimit.limit,
    rateLimitResource: rateLimit.resource
  };
}

async function ingestText(
  pool: pg.Pool,
  vendors: VendorConfig[],
  input: {
    text: string;
    sourceUrl: string;
    sourceType: SourceType;
    repoFullName: string;
    sourceDate?: Date;
    path?: string;
  },
  mode: ScanMode
): Promise<number> {
  const passOne = extractPassOne({ ...input, vendors });
  if (!passOne.candidates.length) return 0;
  const candidates = dedupeCandidates(await enrichAndGateCandidates(passOne.candidates, vendors, log));
  let newCodes = 0;
  for (const candidate of candidates) {
    const result = await upsertPromoCandidate(pool, candidate);
    if (!result.isNew) continue;
    newCodes += 1;
    const alertable = mode === 'live' && (candidate.confidence === 'high' || candidate.confidence === 'medium');
    if (alertable) {
      const results = await notifyAll(candidate);
      const failures = results.filter((item) => !item.sent && !item.skipped);
      if (failures.length) log('alert_delivery_failed', { channels: failures.map((item) => item.channel), vendor: candidate.vendor, code: candidate.code });
    }
  }
  return newCodes;
}

async function commitDetailText(github: GitHubClient, repoFullName: string, sha: string): Promise<{ text: string; detail?: CommitDetail }> {
  const response = await github.request<CommitDetail>(`/repos/${repoFullName}/commits/${sha}`);
  const detail = response.data;
  const patches = detail?.files?.map((file) => `\n--- ${file.filename ?? 'file'} ---\n${file.patch ?? ''}`).join('\n') ?? '';
  return { text: `${detail?.commit?.message ?? ''}\n${patches}`, detail };
}

async function scanCommitItems(
  options: PollerOptions,
  items: CommitSearchItem[],
  mode: ScanMode
): Promise<number> {
  let newCodes = 0;
  let detailsFetched = 0;
  for (const item of items) {
    const repoFullName = item.repository?.full_name ?? 'unknown/unknown';
    const sourceDate = dateOrUndefined(item.commit?.committer?.date ?? item.commit?.author?.date);
    let text = item.commit?.message ?? '';
    if (detailsFetched < config.maxCommitDetailsPerScan && repoFullName !== 'unknown/unknown' && item.sha) {
      try {
        const detail = await commitDetailText(options.github, repoFullName, item.sha);
        text = detail.text;
        detailsFetched += 1;
      } catch (error) {
        log('commit_detail_failed', { repoFullName, sha: item.sha, error: error instanceof Error ? error.message : 'unknown' });
      }
    }
    newCodes += await ingestText(options.pool, options.vendors, {
      text,
      sourceUrl: item.html_url,
      sourceType: mode === 'backfill' ? 'commit' : 'commit',
      repoFullName,
      sourceDate
    }, mode);
  }
  return newCodes;
}

export async function scanFastLane(options: PollerOptions): Promise<void> {
  const queries = buildSearchQueries(options.vendors);
  if (!queries.length) return;
  const cursor = await getLaneCursor(options.pool, 'fast');
  const index = cursor % queries.length;
  const query = queries[index];
  const queryKey = `fast:${index}`;
  try {
    const commitQuery = addRecentCommitDateWindow(query, config.liveCommitWindowDays);
    for (const scan of [
      () => scanCommitSearch(options, commitQuery, queryKey, 'live'),
      () => scanIssueSearch(options, query, queryKey, 'live')
    ]) {
      try {
        await scan();
      } catch (error) {
        log('query_scan_failed', { queryKey, error: error instanceof Error ? error.message : 'unknown' });
      }
    }
  } finally {
    await advanceLaneCursor(options.pool, 'fast', (index + 1) % queries.length);
  }
}

interface CommitScanResult extends IngestResult {
  complete: boolean;
  pagesScanned: number;
}

function uniqueCommitItems(items: CommitSearchItem[]): CommitSearchItem[] {
  const seen = new Set<string>();
  const unique: CommitSearchItem[] = [];
  for (const item of items) {
    const key = item.sha || item.html_url;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function scanCommitSearch(
  options: PollerOptions,
  query: string,
  queryKey: string,
  mode: ScanMode,
  cursorWindow?: string
): Promise<CommitScanResult> {
  const allItems: CommitSearchItem[] = [];
  let pagesScanned = 0;
  let totalCount = 0;
  let complete = true;
  let lastResponse: Awaited<ReturnType<GitHubClient['request']>> | undefined;

  for (let page = 1; page <= config.maxCommitSearchPages; page += 1) {
    const cacheKey = `search:commits:${queryKey}:${cursorWindow ?? 'latest'}:page1`;
    const useEtag = page === 1 && mode === 'live';
    if (useEtag) {
      const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, queryKey, `commits-${cursorWindow ?? 'latest'}`);
      if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
    }
    const response = await options.github.request<SearchResponse<CommitSearchItem>>(
      `/search/commits?q=${encodeQuery(query)}&sort=committer-date&order=desc&per_page=${config.searchPageSize}&page=${page}`,
      useEtag ? { cacheKey, accept: 'application/vnd.github+json' } : { accept: 'application/vnd.github+json' }
    );
    lastResponse = response;
    pagesScanned += 1;
    const items = response.notModified ? [] : response.data?.items ?? [];
    totalCount = response.data?.total_count ?? totalCount;
    allItems.push(...items);
    if (response.notModified || items.length < config.searchPageSize) break;
    const scannedCount = uniqueCommitItems(allItems).length;
    if (totalCount > 0 && scannedCount >= Math.min(totalCount, 1000)) break;
    if (page === config.maxCommitSearchPages) {
      complete = totalCount > 0 ? scannedCount >= Math.min(totalCount, 1000) : false;
    }
  }

  const items = uniqueCommitItems(allItems);
  const newCodes = await scanCommitItems(options, items, mode);
  await insertScanRun(options.pool, {
    queryKey,
    surface: `commits-${cursorWindow ?? 'latest'}`,
    mode,
    cursorWindow,
    etag: lastResponse?.etag,
    hitsFound: items.length,
    newCodes,
    ...rateLimitFields(lastResponse?.rateLimit ?? {})
  });
  if (lastResponse) {
    await options.github.paceIfNeeded(lastResponse.rateLimit, mode === 'backfill' ? config.minimumRateLimitPercent : config.liveMinimumRateLimitPercent);
  }
  return {
    hitsFound: items.length,
    newCodes,
    rateLimitRemaining: lastResponse?.rateLimit.remaining,
    etag: lastResponse?.etag,
    complete,
    pagesScanned
  };
}

async function scanIssueSearch(options: PollerOptions, query: string, queryKey: string, mode: ScanMode): Promise<IngestResult> {
  const cacheKey = `search:issues:${queryKey}`;
  const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, queryKey, 'issues');
  if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
  const issueQuery = addIssueQualifier(query, 'issue');
  const response = await options.github.request<SearchResponse<IssueSearchItem>>(
    `/search/issues?q=${encodeQuery(issueQuery)}&sort=created&order=desc&per_page=${config.searchPageSize}`,
    { cacheKey }
  );
  const items = response.notModified ? [] : response.data?.items ?? [];
  let newCodes = 0;
  for (const item of items) {
    newCodes += await ingestText(options.pool, options.vendors, {
      text: `${item.title ?? ''}\n${item.body ?? ''}`,
      sourceUrl: item.html_url,
      sourceType: 'issue',
      repoFullName: repoFromRepositoryUrl(item.repository_url),
      sourceDate: dateOrUndefined(item.created_at)
    }, mode);
  }
  await insertScanRun(options.pool, {
    queryKey,
    surface: 'issues',
    mode,
    etag: response.etag,
    hitsFound: items.length,
    newCodes,
    ...rateLimitFields(response.rateLimit)
  });
  await options.github.paceIfNeeded(response.rateLimit, config.liveMinimumRateLimitPercent);
  return { hitsFound: items.length, newCodes, rateLimitRemaining: response.rateLimit.remaining, etag: response.etag };
}

export async function scanSlowLane(options: PollerOptions): Promise<void> {
  const queries = buildCodeSearchQueries(options.vendors);
  if (!queries.length) return;
  const cursor = await getLaneCursor(options.pool, 'slow');
  const index = cursor % queries.length;
  const query = queries[index];
  const queryKey = `slow:${index}`;
  try {
    try {
      await scanCodeSearch(options, query, queryKey);
    } catch (error) {
      log('query_scan_failed', { queryKey, error: error instanceof Error ? error.message : 'unknown' });
    }
  } finally {
    await advanceLaneCursor(options.pool, 'slow', (index + 1) % queries.length);
  }
}

function uniqueCodeItems(items: CodeSearchItem[]): CodeSearchItem[] {
  const seen = new Set<string>();
  const unique: CodeSearchItem[] = [];
  for (const item of items) {
    const key = `${item.repository?.full_name ?? ''}:${item.path}:${item.sha ?? item.html_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function scanCodeSearch(options: PollerOptions, query: string, queryKey: string): Promise<IngestResult> {
  const allItems: CodeSearchItem[] = [];
  let totalCount = 0;
  let lastResponse: Awaited<ReturnType<GitHubClient['request']>> | undefined;

  for (let page = 1; page <= config.maxCodeSearchPages; page += 1) {
    const cacheKey = `search:code:${queryKey}`;
    if (page === 1) {
      const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, queryKey, 'code');
      if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
    }
    const response = await options.github.request<SearchResponse<CodeSearchItem>>(
      `/search/code?q=${encodeQuery(query)}&sort=indexed&order=desc&per_page=${config.searchPageSize}&page=${page}`,
      page === 1 ? { cacheKey, accept: 'application/vnd.github.text-match+json' } : { accept: 'application/vnd.github.text-match+json' }
    );
    lastResponse = response;
    const pageItems = response.notModified ? [] : response.data?.items ?? [];
    totalCount = response.data?.total_count ?? totalCount;
    allItems.push(...pageItems);
    if (response.notModified || pageItems.length < config.searchPageSize) break;
    if (totalCount > 0 && uniqueCodeItems(allItems).length >= Math.min(totalCount, 1000)) break;
  }

  const items = uniqueCodeItems(allItems);
  let newCodes = 0;
  let filesFetched = 0;
  for (const item of items) {
    const repoFullName = item.repository?.full_name ?? 'unknown/unknown';
    let text = item.text_matches?.map((match) => match.fragment ?? '').join('\n') ?? '';
    if (filesFetched < config.maxCodeFilesPerScan && repoFullName !== 'unknown/unknown') {
      const content = await fetchRepoFile(options.github, repoFullName, item.path, item.sha).catch(() => undefined);
      if (content) {
        text = content;
        filesFetched += 1;
      }
    }
    newCodes += await ingestText(options.pool, options.vendors, {
      text,
      sourceUrl: item.html_url,
      sourceType: 'code',
      repoFullName,
      path: item.path
    }, 'live');
  }
  await insertScanRun(options.pool, {
    queryKey,
    surface: 'code',
    mode: 'live',
    etag: lastResponse?.etag,
    hitsFound: items.length,
    newCodes,
    ...rateLimitFields(lastResponse?.rateLimit ?? {})
  });
  if (lastResponse) await options.github.paceIfNeeded(lastResponse.rateLimit, config.liveMinimumRateLimitPercent);
  return { hitsFound: items.length, newCodes, rateLimitRemaining: lastResponse?.rateLimit.remaining, etag: lastResponse?.etag };
}

async function fetchRepoFile(github: GitHubClient, repoFullName: string, filePath: string, ref?: string): Promise<string | undefined> {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const response = await github.request<{ content?: string; encoding?: string }>(`/repos/${repoFullName}/contents/${encodedPath}${refQuery}`);
  if (!response.data?.content || response.data.encoding !== 'base64') return undefined;
  return Buffer.from(response.data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

export async function scanWatchlist(options: PollerOptions): Promise<void> {
  for (const entry of options.watchlist) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(entry.repo)) continue;
    const cacheKey = `watchlist:${entry.repo}`;
    try {
      const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, cacheKey, 'core-commits');
      if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
      const response = await options.github.request<RepoCommitListItem[]>(`/repos/${entry.repo}/commits?per_page=20`, { cacheKey });
      const items = response.notModified ? [] : response.data ?? [];
      let newCodes = 0;
      for (const item of items) {
        let text = item.commit?.message ?? '';
        try {
          const detail = await commitDetailText(options.github, entry.repo, item.sha);
          text = detail.text;
        } catch (error) {
          log('watchlist_detail_failed', { repo: entry.repo, sha: item.sha, error: error instanceof Error ? error.message : 'unknown' });
        }
        newCodes += await ingestText(options.pool, options.vendors, {
          text,
          sourceUrl: item.html_url,
          sourceType: 'watchlist',
          repoFullName: entry.repo,
          sourceDate: dateOrUndefined(item.commit?.committer?.date)
        }, 'live');
      }
      await insertScanRun(options.pool, {
        queryKey: cacheKey,
        surface: 'core-commits',
        mode: 'live',
        etag: response.etag,
        hitsFound: items.length,
        newCodes,
        ...rateLimitFields(response.rateLimit)
      });
      await options.github.paceIfNeeded(response.rateLimit, config.liveMinimumRateLimitPercent);
    } catch (error) {
      log('watchlist_scan_failed', { repo: entry.repo, error: error instanceof Error ? error.message : 'unknown' });
    }
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function previousWindow(lastWindow: string | undefined, days: number): { start: string; end: string } {
  const end = new Date();
  if (process.env.BACKFILL_START_DATE && !lastWindow) {
    end.setTime(new Date(process.env.BACKFILL_START_DATE).getTime());
  } else if (lastWindow) {
    const lastStart = lastWindow.split('..')[0];
    end.setTime(new Date(lastStart).getTime());
    end.setUTCDate(end.getUTCDate() - 1);
  }
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: isoDate(start), end: isoDate(end) };
}

function windowDayCount(start: string, end: string): number {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((endMs - startMs) / 86_400_000) + 1);
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

async function scanBackfillQueryRange(
  options: PollerOptions,
  baseQuery: string,
  bundle: number,
  start: string,
  end: string
): Promise<boolean> {
  const cursorWindow = `${start}..${end}`;
  const query = addCommitDateWindow(baseQuery, start, end);
  try {
    const result = await scanCommitSearch(options, query, `backfill:${bundle}`, 'backfill', cursorWindow);
    if (result.complete) return true;
    const days = windowDayCount(start, end);
    if (days <= 1) {
      log('backfill_query_incomplete', { cursorWindow, bundle, pagesScanned: result.pagesScanned, hitsFound: result.hitsFound });
      return false;
    }
    const leftDays = Math.floor(days / 2);
    const mid = shiftIsoDate(start, leftDays - 1);
    const rightStart = shiftIsoDate(mid, 1);
    log('backfill_window_split', { cursorWindow, bundle, left: `${start}..${mid}`, right: `${rightStart}..${end}` });
    const leftComplete = await scanBackfillQueryRange(options, baseQuery, bundle, start, mid);
    const rightComplete = await scanBackfillQueryRange(options, baseQuery, bundle, rightStart, end);
    return leftComplete && rightComplete;
  } catch (error) {
    log('backfill_query_failed', { cursorWindow, bundle, error: error instanceof Error ? error.message : 'unknown' });
    return false;
  }
}

export async function scanHistoricalBackfill(options: PollerOptions): Promise<void> {
  if (!config.backfillEnabled) return;
  const lastWindow = await latestBackfillWindow(options.pool);
  const window = previousWindow(lastWindow, config.backfillDaysPerWindow);
  if (new Date(window.end).getTime() < new Date(config.backfillStopDate).getTime()) return;
  const cursorWindow = `${window.start}..${window.end}`;
  const queries = buildSearchQueries(options.vendors);
  let incompleteQueries = 0;
  for (let index = 0; index < queries.length; index += 1) {
    const complete = await scanBackfillQueryRange(options, queries[index], index, window.start, window.end);
    if (!complete) incompleteQueries += 1;
  }
  if (incompleteQueries > 0) {
    log('backfill_window_incomplete', { cursorWindow, incompleteQueries });
    return;
  }
  await insertScanRun(options.pool, {
    queryKey: BACKFILL_WINDOW_COMPLETE_KEY,
    surface: 'window-complete',
    mode: 'backfill',
    cursorWindow,
    hitsFound: 0,
    newCodes: 0
  });
  log('backfill_window_complete', { cursorWindow });
}
