import {
  BACKFILL_WINDOW_COMPLETE_KEY,
  GITHUB_SEARCH_RESULT_CEILING,
  GitHubClient,
  addCommitDateWindow,
  addIssueDateWindow,
  addIssueQualifier,
  addRecentCommitDateWindow,
  halveSearchWindow,
  hasSeenCommitSha,
  pagesNeededForTotal,
  parseBoundedWindow,
  advanceLaneCursor,
  buildCodeSearchQueries,
  buildSearchQueries,
  classifyLlmFailure,
  configuredLlmModel,
  configuredLlmProvider,
  dedupeCandidates,
  encodeQuery,
  enrichAndGateCandidates,
  extractPassOne,
  getLaneCursor,
  getLaneCursorState,
  insertLlmCall,
  insertLlmGateEvent,
  insertScanRun,
  isFollowableRepo,
  isRateLimitErrorMessage,
  laneFromQueryKey,
  latestBackfillWindow,
  latestEtag,
  listFollowedRepos,
  markFollowedRepoPolled,
  notifyAll,
  previousBackfillWindow,
  readLlmInputCache,
  rememberCommitSha,
  rememberFollowedRepo,
  searchPageCapSaturated,
  singlePageWasFull,
  syncFollowedRepos,
  upsertPromoCandidate,
  writeLlmInputCache,
  type ExtractedPromo,
  type GitHubResponse,
  type LlmUsageRecord,
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

export interface IngestCounts {
  newCodes: number;
  pass1Candidates: number;
  pass1Hits: number;
  gateAccepted: number;
  gateRejected: number;
  gateFailed: number;
  gateBypassed: number;
}

function emptyIngest(): IngestCounts {
  return { newCodes: 0, pass1Candidates: 0, pass1Hits: 0, gateAccepted: 0, gateRejected: 0, gateFailed: 0, gateBypassed: 0 };
}

const seenCommitKeys = new Set<string>();

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
  return (await ingestObservedText(pool, vendors, input, mode)).newCodes;
}

export async function ingestObservedText(
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
): Promise<IngestCounts> {
  const passOne = extractPassOne({ ...input, vendors });
  if (!passOne.candidates.length) return emptyIngest();
  const counts = emptyIngest();
  counts.pass1Candidates = passOne.candidates.length;
  counts.pass1Hits = 1;
  const provider = configuredLlmProvider();
  if (provider === 'none') counts.gateBypassed = passOne.candidates.length;
  const candidates = dedupeCandidates(await enrichAndGateCandidates(passOne.candidates, vendors, (event, details) => {
    log(event, details);
    if (event === 'llm_gate_accepted') counts.gateAccepted += 1;
    else if (event === 'llm_gate_rejected') counts.gateRejected += 1;
    else if (event === 'llm_gate_failed') counts.gateFailed += 1;
    const decision = event === 'llm_gate_accepted'
      ? 'accepted'
      : event === 'llm_gate_rejected'
        ? 'rejected'
        : event === 'llm_gate_failed'
          ? 'failed'
          : null;
    if (!decision) return;
    const reason = decision === 'accepted'
      ? null
      : decision === 'rejected'
        ? (details.reason === 'invalid-code-or-vendor' ? 'invalid-code-or-vendor' : 'not-public-promo')
        : classifyLlmFailure(typeof details.reason === 'string' ? details.reason : undefined).code;
    void insertLlmGateEvent(pool, {
      provider,
      model: configuredLlmModel(),
      decision,
      reason
    }).catch((error) => {
      log('llm_gate_persist_failed', { error: error instanceof Error ? error.message : 'unknown' });
    });
  }, {
    onCall: (record: LlmUsageRecord) => insertLlmCall(pool, record).catch((error) => {
      log('llm_usage_persist_failed', { error: error instanceof Error ? error.message : 'unknown' });
    }),
    lookupCache: async (hash) => {
      const row = await readLlmInputCache(pool, hash);
      if (!row) return null;
      if (row.outcome === 'rejected') return { outcome: 'rejected' };
      if (!row.resultJson) return { outcome: 'rejected' };
      try {
        return { outcome: 'accepted', result: JSON.parse(row.resultJson) as ExtractedPromo };
      } catch {
        return null;
      }
    },
    storeCache: async (hash, hit) => {
      const json = hit.outcome === 'accepted' && hit.result
        ? JSON.stringify({ ...hit.result, expiresAt: hit.result.expiresAt ? new Date(hit.result.expiresAt).toISOString() : undefined })
        : null;
      await writeLlmInputCache(pool, hash, hit.outcome, json);
    }
  }));
  for (const candidate of candidates) {
    const result = await upsertPromoCandidate(pool, candidate);
    if (isFollowableRepo(candidate.repoFullName)) {
      try {
        await rememberFollowedRepo(pool, candidate.repoFullName, result.isNew || result.insertedSighting);
      } catch (error) {
        log('followed_repo_remember_failed', {
          repoFullName: candidate.repoFullName,
          error: error instanceof Error ? error.message : 'unknown'
        });
      }
    }
    if (!result.isNew) continue;
    counts.newCodes += 1;
    const alertable = mode === 'live' && (candidate.confidence === 'high' || candidate.confidence === 'medium');
    if (alertable) {
      const results = await notifyAll(candidate);
      const failures = results.filter((item) => !item.sent && !item.skipped);
      if (failures.length) log('alert_delivery_failed', { channels: failures.map((item) => item.channel), vendor: candidate.vendor, code: candidate.code });
    }
  }
  return counts;
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
    const seenKey = item.sha ? `${repoFullName}@${item.sha}` : '';
    const alreadySeen = Boolean(seenKey && (seenCommitKeys.has(seenKey) || await hasSeenCommitSha(options.pool, repoFullName, item.sha)));
    if (alreadySeen && seenKey) seenCommitKeys.add(seenKey);
    if (!alreadySeen && detailsFetched < config.maxCommitDetailsPerScan && repoFullName !== 'unknown/unknown' && item.sha) {
      try {
        const detail = await commitDetailText(options.github, repoFullName, item.sha);
        text = detail.text;
        detailsFetched += 1;
        seenCommitKeys.add(seenKey);
        await rememberCommitSha(options.pool, repoFullName, item.sha);
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

async function fetchSearchPage<T>(
  github: GitHubClient,
  path: string,
  requestOptions: { cacheKey?: string; accept?: string },
  context: Record<string, unknown>
): Promise<{ ok: true; response: GitHubResponse<SearchResponse<T>> } | { ok: false; error: string }> {
  try {
    const response = await github.request<SearchResponse<T>>(path, requestOptions);
    return { ok: true, response };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    log('search_page_failed', { ...context, error: message });
    return { ok: false, error: message };
  }
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
  let lastPageFull = false;
  let pageFailed = false;
  let rateLimited = false;
  let reportedIncomplete = false;
  let lastResponse: GitHubResponse<SearchResponse<CommitSearchItem>> | undefined;
  const minimumRateLimitPercent = mode === 'backfill' ? config.minimumRateLimitPercent : config.liveMinimumRateLimitPercent;

  for (let page = 1; page <= config.maxCommitSearchPages; page += 1) {
    const cacheKey = `search:commits:${queryKey}:${cursorWindow ?? 'latest'}:page1`;
    const useEtag = page === 1 && mode === 'live';
    if (useEtag) {
      const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, queryKey, `commits-${cursorWindow ?? 'latest'}`);
      if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
    }
    const fetched = await fetchSearchPage<CommitSearchItem>(
      options.github,
      `/search/commits?q=${encodeQuery(query)}&sort=committer-date&order=desc&per_page=${config.searchPageSize}&page=${page}`,
      useEtag ? { cacheKey, accept: 'application/vnd.github+json' } : { accept: 'application/vnd.github+json' },
      { queryKey, surface: 'commits', page }
    );
    if (!fetched.ok) {
      complete = false;
      pageFailed = true;
      rateLimited = isRateLimitErrorMessage(fetched.error);
      break;
    }
    const response = fetched.response;
    lastResponse = response;
    pagesScanned += 1;
    const items = response.notModified ? [] : response.data?.items ?? [];
    totalCount = response.data?.total_count ?? totalCount;
    reportedIncomplete = reportedIncomplete || Boolean(response.data?.incomplete_results);
    allItems.push(...items);
    lastPageFull = items.length >= config.searchPageSize;
    if (
      page === 1
      && !response.notModified
      && totalCount > GITHUB_SEARCH_RESULT_CEILING
    ) {
      const split = splitDatedQuery(query, 'committer-date');
      if (split) {
        const left = await scanCommitSearch(options, split.leftQuery, queryKey, mode, split.leftSpec);
        const right = await scanCommitSearch(options, split.rightQuery, queryKey, mode, split.rightSpec);
        return {
          hitsFound: left.hitsFound + right.hitsFound,
          newCodes: left.newCodes + right.newCodes,
          rateLimitRemaining: right.rateLimitRemaining ?? left.rateLimitRemaining,
          etag: right.etag ?? left.etag,
          complete: left.complete && right.complete,
          pagesScanned: left.pagesScanned + right.pagesScanned
        };
      }
    }
    if (response.notModified || !lastPageFull) break;
    const scannedCount = uniqueCommitItems(allItems).length;
    const needed = pagesNeededForTotal(totalCount, config.searchPageSize, config.maxCommitSearchPages);
    if (totalCount > 0 && scannedCount >= Math.min(totalCount, GITHUB_SEARCH_RESULT_CEILING)) break;
    if (page >= needed) {
      if (totalCount > scannedCount) complete = false;
      break;
    }
    if (page === config.maxCommitSearchPages) {
      complete = totalCount > 0 ? scannedCount >= Math.min(totalCount, GITHUB_SEARCH_RESULT_CEILING) : false;
    } else {
      await options.github.paceIfNeeded(response.rateLimit, minimumRateLimitPercent);
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
    pagesScanned,
    reportedTotal: totalCount,
    capSaturated: searchPageCapSaturated({
      hitsFetched: items.length,
      reportedTotal: totalCount,
      pageFailed
    }),
    rateLimited,
    reportedIncomplete,
    lane: laneFromQueryKey(queryKey),
    ...rateLimitFields(lastResponse?.rateLimit ?? {})
  });
  if (lastResponse) {
    await options.github.paceIfNeeded(lastResponse.rateLimit, minimumRateLimitPercent);
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

function uniqueIssueItems(items: IssueSearchItem[]): IssueSearchItem[] {
  const seen = new Set<string>();
  const unique: IssueSearchItem[] = [];
  for (const item of items) {
    if (!item.html_url || seen.has(item.html_url)) continue;
    seen.add(item.html_url);
    unique.push(item);
  }
  return unique;
}

async function scanIssueSearch(options: PollerOptions, query: string, queryKey: string, mode: ScanMode): Promise<IngestResult> {
  const cacheKey = `search:issues:${queryKey}`;
  const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, queryKey, 'issues');
  if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
  const issueQuery = query.includes(' created:') ? query : addIssueDateWindow(query, ...liveDateEnds(config.liveCommitWindowDays));
  const allItems: IssueSearchItem[] = [];
  let pagesScanned = 0;
  let totalCount = 0;
  let lastPageFull = false;
  let pageFailed = false;
  let rateLimited = false;
  let reportedIncomplete = false;
  let lastResponse: GitHubResponse<SearchResponse<IssueSearchItem>> | undefined;

  for (let page = 1; page <= config.maxIssueSearchPages; page += 1) {
    const fetched = await fetchSearchPage<IssueSearchItem>(
      options.github,
      `/search/issues?q=${encodeQuery(issueQuery)}&sort=created&order=desc&per_page=${config.searchPageSize}&page=${page}`,
      page === 1 ? { cacheKey } : {},
      { queryKey, surface: 'issues', page }
    );
    if (!fetched.ok) {
      pageFailed = true;
      rateLimited = isRateLimitErrorMessage(fetched.error);
      break;
    }
    const response = fetched.response;
    lastResponse = response;
    pagesScanned += 1;
    const pageItems = response.notModified ? [] : response.data?.items ?? [];
    totalCount = response.data?.total_count ?? totalCount;
    reportedIncomplete = reportedIncomplete || Boolean(response.data?.incomplete_results);
    allItems.push(...pageItems);
    lastPageFull = pageItems.length >= config.searchPageSize;
    if (page === 1 && !response.notModified && totalCount > GITHUB_SEARCH_RESULT_CEILING) {
      const split = splitDatedQuery(issueQuery, 'created');
      if (split) {
        const left = await scanIssueSearch(options, split.leftQuery, queryKey, mode);
        const right = await scanIssueSearch(options, split.rightQuery, queryKey, mode);
        return {
          hitsFound: left.hitsFound + right.hitsFound,
          newCodes: left.newCodes + right.newCodes,
          rateLimitRemaining: right.rateLimitRemaining ?? left.rateLimitRemaining,
          etag: right.etag ?? left.etag
        };
      }
    }
    if (response.notModified || !lastPageFull) break;
    const scannedCount = uniqueIssueItems(allItems).length;
    const needed = pagesNeededForTotal(totalCount, config.searchPageSize, config.maxIssueSearchPages);
    if (totalCount > 0 && scannedCount >= Math.min(totalCount, GITHUB_SEARCH_RESULT_CEILING)) break;
    if (page >= needed) break;
    if (page < config.maxIssueSearchPages) {
      await options.github.paceIfNeeded(response.rateLimit, config.liveMinimumRateLimitPercent);
    }
  }

  const items = uniqueIssueItems(allItems);
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
    etag: lastResponse?.etag,
    hitsFound: items.length,
    newCodes,
    pagesScanned,
    reportedTotal: totalCount,
    capSaturated: searchPageCapSaturated({
      hitsFetched: items.length,
      reportedTotal: totalCount,
      pageFailed
    }),
    rateLimited,
    reportedIncomplete,
    lane: laneFromQueryKey(queryKey),
    ...rateLimitFields(lastResponse?.rateLimit ?? {})
  });
  if (lastResponse) await options.github.paceIfNeeded(lastResponse.rateLimit, config.liveMinimumRateLimitPercent);
  return { hitsFound: items.length, newCodes, rateLimitRemaining: lastResponse?.rateLimit.remaining, etag: lastResponse?.etag };
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
  let pagesScanned = 0;
  let totalCount = 0;
  let lastPageFull = false;
  let pageFailed = false;
  let rateLimited = false;
  let reportedIncomplete = false;
  let lastResponse: GitHubResponse<SearchResponse<CodeSearchItem>> | undefined;

  for (let page = 1; page <= config.maxCodeSearchPages; page += 1) {
    const cacheKey = `search:code:${queryKey}`;
    if (page === 1) {
      const storedEtag = options.github.getEtag(cacheKey) ?? await latestEtag(options.pool, queryKey, 'code');
      if (storedEtag && !options.github.getEtag(cacheKey)) options.github.setEtag(cacheKey, storedEtag);
    }
    const fetched = await fetchSearchPage<CodeSearchItem>(
      options.github,
      `/search/code?q=${encodeQuery(query)}&sort=indexed&order=desc&per_page=${config.searchPageSize}&page=${page}`,
      page === 1 ? { cacheKey, accept: 'application/vnd.github.text-match+json' } : { accept: 'application/vnd.github.text-match+json' },
      { queryKey, surface: 'code', page }
    );
    if (!fetched.ok) {
      pageFailed = true;
      rateLimited = isRateLimitErrorMessage(fetched.error);
      break;
    }
    const response = fetched.response;
    lastResponse = response;
    pagesScanned += 1;
    const pageItems = response.notModified ? [] : response.data?.items ?? [];
    totalCount = response.data?.total_count ?? totalCount;
    reportedIncomplete = reportedIncomplete || Boolean(response.data?.incomplete_results);
    allItems.push(...pageItems);
    lastPageFull = pageItems.length >= config.searchPageSize;
    if (response.notModified || !lastPageFull) break;
    const scannedCount = uniqueCodeItems(allItems).length;
    if (totalCount > 0 && scannedCount >= Math.min(totalCount, GITHUB_SEARCH_RESULT_CEILING)) break;
    if (page >= pagesNeededForTotal(totalCount, config.searchPageSize, config.maxCodeSearchPages)) break;
    if (page < config.maxCodeSearchPages) {
      await options.github.paceIfNeeded(response.rateLimit, config.liveMinimumRateLimitPercent);
    }
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
    pagesScanned,
    reportedTotal: totalCount,
    capSaturated: searchPageCapSaturated({
      hitsFetched: items.length,
      reportedTotal: totalCount,
      pageFailed
    }),
    rateLimited,
    reportedIncomplete,
    lane: laneFromQueryKey(queryKey),
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

export const STATIC_WATCHLIST_COMMIT_PAGE_SIZE = 20;

interface RepoCommitPoll {
  repo: string;
  queryKey: string;
  perPage: number;
  maxDetails: number;
  lane: 'watchlist' | 'followed';
}

async function pollRepoCommits(options: PollerOptions, poll: RepoCommitPoll): Promise<number> {
  const storedEtag = options.github.getEtag(poll.queryKey) ?? await latestEtag(options.pool, poll.queryKey, 'core-commits');
  if (storedEtag && !options.github.getEtag(poll.queryKey)) options.github.setEtag(poll.queryKey, storedEtag);
  const response = await options.github.request<RepoCommitListItem[]>(
    `/repos/${poll.repo}/commits?per_page=${poll.perPage}`,
    { cacheKey: poll.queryKey }
  );
  const items = response.notModified ? [] : response.data ?? [];
  let newCodes = 0;
  let detailsFetched = 0;
  for (const item of items) {
    let text = item.commit?.message ?? '';
    const seenKey = item.sha ? `${poll.repo}@${item.sha}` : '';
    const alreadySeen = Boolean(seenKey && (seenCommitKeys.has(seenKey) || await hasSeenCommitSha(options.pool, poll.repo, item.sha)));
    if (alreadySeen && seenKey) seenCommitKeys.add(seenKey);
    if (!alreadySeen && detailsFetched < poll.maxDetails && item.sha) {
      detailsFetched += 1;
      try {
        const detail = await commitDetailText(options.github, poll.repo, item.sha);
        text = detail.text;
        seenCommitKeys.add(seenKey);
        await rememberCommitSha(options.pool, poll.repo, item.sha);
      } catch (error) {
        log('repo_commit_detail_failed', {
          lane: poll.lane,
          repo: poll.repo,
          sha: item.sha,
          error: error instanceof Error ? error.message : 'unknown'
        });
      }
    }
    newCodes += await ingestText(options.pool, options.vendors, {
      text,
      sourceUrl: item.html_url,
      sourceType: 'watchlist',
      repoFullName: poll.repo,
      sourceDate: dateOrUndefined(item.commit?.committer?.date)
    }, 'live');
  }
  await insertScanRun(options.pool, {
    queryKey: poll.queryKey,
    surface: 'core-commits',
    mode: 'live',
    etag: response.etag,
    hitsFound: items.length,
    newCodes,
    pagesScanned: 1,
    capSaturated: singlePageWasFull(items.length, poll.perPage),
    rateLimited: false,
    lane: poll.lane === 'followed' ? 'followed' : 'watchlist',
    ...rateLimitFields(response.rateLimit)
  });
  await options.github.paceIfNeeded(response.rateLimit, config.liveMinimumRateLimitPercent);
  return detailsFetched;
}

export async function scanWatchlist(options: PollerOptions): Promise<void> {
  try {
    await syncFollowedRepos(options.pool);
  } catch (error) {
    log('followed_repo_sync_failed', { error: error instanceof Error ? error.message : 'unknown' });
  }

  const staticRepos = options.watchlist.map((entry) => entry.repo).filter((repo) => isFollowableRepo(repo));
  for (const repo of staticRepos) {
    try {
      await pollRepoCommits(options, {
        repo,
        queryKey: `watchlist:${repo}`,
        perPage: STATIC_WATCHLIST_COMMIT_PAGE_SIZE,
        maxDetails: STATIC_WATCHLIST_COMMIT_PAGE_SIZE,
        lane: 'watchlist'
      });
    } catch (error) {
      log('watchlist_scan_failed', { repo, error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  let followed: string[] = [];
  try {
    followed = await listFollowedRepos(options.pool, config.maxFollowedReposPerScan, staticRepos);
  } catch (error) {
    log('followed_repo_list_failed', { error: error instanceof Error ? error.message : 'unknown' });
    return;
  }

  let detailsBudget = config.maxFollowedCommitDetailsPerScan;
  for (const repo of followed) {
    const maxDetails = Math.min(config.maxFollowedCommitDetailsPerRepo, detailsBudget);
    try {
      const used = await pollRepoCommits(options, {
        repo,
        queryKey: `followed:${repo}`,
        perPage: config.followedRepoCommitPageSize,
        maxDetails,
        lane: 'followed'
      });
      detailsBudget = Math.max(0, detailsBudget - used);
    } catch (error) {
      log('followed_repo_scan_failed', { repo, error: error instanceof Error ? error.message : 'unknown' });
    } finally {
      try {
        await markFollowedRepoPolled(options.pool, repo);
      } catch (error) {
        log('followed_repo_mark_failed', { repo, error: error instanceof Error ? error.message : 'unknown' });
      }
    }
  }
}

function liveDateEnds(days: number, now = new Date()): [string, string] {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Math.floor(days)) + 1);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return [iso(start), iso(end)];
}

function splitDatedQuery(query: string, qualifier: 'committer-date' | 'created'): { leftQuery: string; rightQuery: string; leftSpec: string; rightSpec: string } | null {
  const match = query.match(new RegExp(`^(.*) ${qualifier}:(\\S+\\.\\.\\S+)$`));
  if (!match) return null;
  const bounds = parseBoundedWindow(match[2]);
  if (!bounds) return null;
  const halves = halveSearchWindow(bounds.start, bounds.endExclusive);
  if (!halves) return null;
  const base = match[1];
  const qualify = (spec: string) => {
    const [start, end] = spec.split('..');
    return `${base} ${qualifier}:${start}..${end}`;
  };
  return { leftQuery: qualify(halves.left), rightQuery: qualify(halves.right), leftSpec: halves.left, rightSpec: halves.right };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function previousWindow(lastWindow: string | undefined, days: number): { start: string; end: string } {
  return previousBackfillWindow(lastWindow, days, new Date(), process.env.BACKFILL_START_DATE || undefined);
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
  const queries = buildSearchQueries(options.vendors);
  if (!queries.length) return;
  const lastWindow = await latestBackfillWindow(options.pool);
  const window = previousWindow(lastWindow, config.backfillDaysPerWindow);
  if (new Date(window.end).getTime() < new Date(config.backfillStopDate).getTime()) return;
  const cursorWindow = `${window.start}..${window.end}`;
  const saved = await getLaneCursorState(options.pool, 'backfill');
  const index = saved.cursorWindow === cursorWindow ? saved.nextIndex % queries.length : 0;
  const complete = await scanBackfillQueryRange(options, queries[index], index, window.start, window.end);
  if (!complete) {
    await advanceLaneCursor(options.pool, 'backfill', index, cursorWindow);
    log('backfill_window_incomplete', { cursorWindow, index, queryCount: queries.length });
    return;
  }
  const next = index + 1;
  if (next >= queries.length) {
    await insertScanRun(options.pool, {
      queryKey: BACKFILL_WINDOW_COMPLETE_KEY,
      surface: 'window-complete',
      mode: 'backfill',
      cursorWindow,
      hitsFound: 0,
      newCodes: 0
    });
    await advanceLaneCursor(options.pool, 'backfill', 0, null);
    log('backfill_window_complete', { cursorWindow, queryCount: queries.length });
    return;
  }
  await advanceLaneCursor(options.pool, 'backfill', next, cursorWindow);
  log('backfill_query_complete', { cursorWindow, index, next, queryCount: queries.length });
}
