import {
  advanceLaneCursor,
  buildExaVendorQuery,
  exaHttpErrorCode,
  exaSearchRequest,
  exaTransportErrorCode,
  getLaneCursor,
  insertExaSearch,
  insertScanRun,
  isGithubWebUrl,
  parseExaHits,
  publicExaSettings,
  repoFromGithubUrl,
  resolveExaCost,
  sourceTypeFromGithubUrl,
  type ExaSearchInsert,
  type VendorConfig
} from '@promo/shared';
import { ingestObservedText, type PollerOptions } from './poller.js';

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function emptyCounts(): Omit<ExaSearchInsert, 'queryKey' | 'vendor' | 'status' | 'searchType' | 'numResultsRequested'> {
  return {
    requests: 0,
    resultsReturned: 0,
    githubResults: 0,
    droppedNonGithub: 0,
    pass1Candidates: 0,
    pass1Hits: 0,
    gateAccepted: 0,
    gateRejected: 0,
    gateFailed: 0,
    gateBypassed: 0,
    newCodes: 0,
    resultCapFull: false
  };
}

async function recordExa(options: PollerOptions, row: ExaSearchInsert): Promise<void> {
  await insertExaSearch(options.pool, row);
  await insertScanRun(options.pool, {
    queryKey: row.queryKey,
    surface: 'exa',
    mode: 'live',
    lane: 'exa',
    hitsFound: row.githubResults,
    newCodes: row.newCodes,
    pagesScanned: row.status === 'ok' ? 1 : 0,
    capSaturated: false,
    rateLimited: row.errorCode === 'http-429',
    reportedIncomplete: false
  });
}

/**
 * One vendor per pass. Exa search returns at most 100 results and has no next page.
 * The lane is skipped entirely when EXA_API_KEY is unset.
 */
export async function scanExaLane(options: PollerOptions): Promise<void> {
  const settings = publicExaSettings(process.env);
  const apiKey = process.env.EXA_API_KEY?.trim() ?? '';
  if (!settings.configured || !apiKey) {
    log('exa_lane_skipped', { reason: 'not-configured' });
    return;
  }
  if (!options.vendors.length) return;
  const cursor = await getLaneCursor(options.pool, 'exa');
  const index = cursor % options.vendors.length;
  const vendor = options.vendors[index];
  const queryKey = `exa:${index}`;
  try {
    await searchVendor(options, vendor, queryKey, apiKey, settings);
  } catch (error) {
    log('exa_lane_failed', { queryKey, vendor: vendor.name, error: exaTransportErrorCode(error) });
  } finally {
    await advanceLaneCursor(options.pool, 'exa', (index + 1) % options.vendors.length);
  }
}

async function searchVendor(
  options: PollerOptions,
  vendor: VendorConfig,
  queryKey: string,
  apiKey: string,
  settings: ReturnType<typeof publicExaSettings>
): Promise<void> {
  const request = exaSearchRequest(buildExaVendorQuery(vendor), apiKey, settings);
  const base: ExaSearchInsert = {
    queryKey,
    vendor: vendor.name,
    status: 'error',
    searchType: settings.type,
    numResultsRequested: settings.numResults,
    maxAgeHours: settings.maxAgeHours,
    publishedWithinDays: settings.publishedWithinDays,
    ...emptyCounts(),
    requests: 1
  };
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs)
    });
  } catch (error) {
    const errorCode = exaTransportErrorCode(error);
    await recordExa(options, { ...base, errorCode });
    log('exa_search_failed', { queryKey, vendor: vendor.name, error: errorCode });
    return;
  }
  if (!response.ok) {
    const errorCode = exaHttpErrorCode(response.status);
    await recordExa(options, { ...base, errorCode });
    log('exa_search_failed', { queryKey, vendor: vendor.name, error: errorCode });
    return;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    await recordExa(options, { ...base, errorCode: 'invalid-json' });
    log('exa_search_failed', { queryKey, vendor: vendor.name, error: 'invalid-json' });
    return;
  }
  const hits = parseExaHits(body);
  const githubHits = hits.filter((hit) => isGithubWebUrl(hit.url) && hit.text.trim());
  const counts = emptyCounts();
  counts.requests = 1;
  counts.resultsReturned = hits.length;
  counts.droppedNonGithub = hits.length - hits.filter((hit) => isGithubWebUrl(hit.url)).length;
  counts.githubResults = githubHits.length;
  counts.resultCapFull = hits.length >= settings.numResults && settings.numResults > 0;
  for (const hit of githubHits) {
    const repoFullName = repoFromGithubUrl(hit.url);
    if (!repoFullName) continue;
    const ingested = await ingestObservedText(options.pool, options.vendors, {
      text: hit.text,
      sourceUrl: hit.url,
      sourceType: sourceTypeFromGithubUrl(hit.url),
      repoFullName,
      sourceDate: hit.publishedDate ? new Date(hit.publishedDate) : undefined
    }, 'live');
    counts.pass1Candidates += ingested.pass1Candidates;
    counts.pass1Hits += ingested.pass1Hits;
    counts.gateAccepted += ingested.gateAccepted;
    counts.gateRejected += ingested.gateRejected;
    counts.gateFailed += ingested.gateFailed;
    counts.gateBypassed += ingested.gateBypassed;
    counts.newCodes += ingested.newCodes;
  }
  const cost = resolveExaCost(settings.type, hits.length, body);
  await recordExa(options, {
    ...base,
    status: 'ok',
    ...counts,
    costUsd: cost.usd,
    costSource: cost.source
  });
  log('exa_search_complete', {
    queryKey,
    vendor: vendor.name,
    searchType: settings.type,
    numResults: settings.numResults,
    resultsReturned: counts.resultsReturned,
    githubResults: counts.githubResults,
    droppedNonGithub: counts.droppedNonGithub,
    pass1Candidates: counts.pass1Candidates,
    newCodes: counts.newCodes,
    resultCapFull: counts.resultCapFull,
    costSource: cost.source
  });
}
