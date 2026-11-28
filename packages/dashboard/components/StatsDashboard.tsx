import type { ReactNode } from 'react';
import type { DashboardStats, PublicWorkerConfig } from '@promo/shared';
import { formatDurationMs, GITHUB_SEARCH_RESULT_CEILING, STATS_HONESTY } from '@promo/shared';

const LANES = ['', 'fast', 'slow', 'backfill', 'watchlist', 'followed', 'exa'] as const;

function formatIst(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  })} IST`;
}

function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-IN').format(value);
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-100">{value}</div>
      {detail ? <p className="mt-2 text-xs leading-5 text-slate-400">{detail}</p> : null}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-8">
      <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: Array<Array<string | number | null>> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-500">
          <tr>{headers.map((header) => <th key={header} className="px-3 py-2 font-medium">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-800 bg-slate-950/40">
          {rows.length ? rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top text-slate-300">{cell ?? '—'}</td>)}
            </tr>
          )) : (
            <tr><td className="px-3 py-4 text-slate-500" colSpan={headers.length}>No rows in this range.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function configRows(config: PublicWorkerConfig | null): Array<[string, string]> {
  if (!config) return [];
  return Object.entries(config).map(([key, value]) => [key, value == null ? '—' : String(value)]);
}

export function StatsDashboard({ stats }: { stats: DashboardStats | null }) {
  if (!stats) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <h1 className="text-3xl font-bold">Scanner stats</h1>
        <p className="mt-3 text-sm text-rose-300">Stats could not be loaded. The database query failed, and the error is not shown here.</p>
        <p className="mt-3 text-sm leading-6 text-slate-400">{STATS_HONESTY.notAQueue}</p>
      </main>
    );
  }

  const { filters } = stats;
  const models = stats.tokens.models.length ? stats.tokens.models : ['gpt-6-luna', 'sarvam-105b'];

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Scanner stats</h1>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Live counts from promo rows, scan runs, LLM usage, and Exa searches. {STATS_HONESTY.ist} Generated {formatIst(stats.generatedAt)}.
        </p>
      </header>

      <nav className="mb-4 flex flex-wrap gap-3 text-sm text-sky-300">
        {['remaining', 'repos', 'tokens', 'gate', 'inventory', 'lanes', 'exa', 'limits', 'config'].map((id) => (
          <a key={id} href={`#${id}`}>{id}</a>
        ))}
      </nav>

      <form className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 md:grid-cols-6" method="get">
        <label className="flex flex-col gap-1 text-xs text-slate-400">From (IST)
          <input name="from" type="date" defaultValue={filters.from} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">To (IST)
          <input name="to" type="date" defaultValue={filters.to} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">Lane
          <select name="lane" defaultValue={filters.lane}>
            {LANES.map((lane) => <option key={lane || 'all'} value={lane}>{lane || 'All lanes'}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">Model
          <select name="model" defaultValue={filters.model}>
            <option value="">All models</option>
            {models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400 md:col-span-2">Search recent rows
          <input name="q" defaultValue={filters.q} placeholder="query key, vendor, reason" />
        </label>
        <div className="flex items-end gap-2 md:col-span-6">
          <button type="submit">Apply</button>
          <a className="button bg-slate-700 hover:bg-slate-600" href="/stats">Reset</a>
        </div>
      </form>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        Date range filters scans, tokens, the LLM gate, Exa, and newly seen repos. Promo inventory totals stay all-time. The model filter applies to tokens and the gate. The lane filter applies to scan tables. Remaining-work cycles and the Exa section stay visible for every lane. Search filters the recent scan, gate, and Exa tables.
      </p>

      <Section id="remaining" title="Remaining work">
        <p className="mb-3 text-sm leading-6 text-slate-300">{stats.honesty.notAQueue}</p>
        <p className="mb-4 text-sm leading-6 text-slate-400">{stats.honesty.reportedTotal} {stats.honesty.unopened}</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Backfill windows left"
            value={stats.remaining.backfill.windowsRemaining == null ? 'unknown' : formatInt(stats.remaining.backfill.windowsRemaining)}
            detail={stats.remaining.backfill.reachedStop
              ? `Backfill has reached the stop date ${stats.remaining.backfill.stopDate}.`
              : `Next window ${stats.remaining.backfill.nextWindow ?? 'unknown'}. Stop ${stats.remaining.backfill.stopDate ?? 'not reported'}. ${stats.remaining.backfill.daysPerWindow ?? '—'} days per window. Each window runs all ${formatInt(stats.remaining.backfill.queriesPerWindow)} commit-search queries before it is marked complete.`}
          />
          <Stat
            label="Last completed backfill window"
            value={stats.remaining.backfill.lastCompletedWindow ?? 'none yet'}
            detail={`Marked complete ${formatIst(stats.remaining.backfill.lastCompletedAt)}. Latest backfill activity window ${stats.remaining.backfill.currentActivityWindow ?? 'none'} at ${formatIst(stats.remaining.backfill.currentActivityAt)}. Enabled: ${stats.remaining.backfill.enabled == null ? 'not reported' : String(stats.remaining.backfill.enabled)}.`}
          />
          {stats.remaining.cycles.map((cycle) => (
            <Stat
              key={cycle.lane}
              label={cycle.label}
              value={cycle.nextQueryNumber == null ? 'cursor unknown' : `Query ${cycle.nextQueryNumber} of ${cycle.queryCount}`}
              detail={`Full cycle ${formatDurationMs(cycle.estimatedFullCycleMs)} (${cycle.basis}). Nominal ${formatDurationMs(cycle.nominalCycleMs)}. Observed median step ${formatDurationMs(cycle.observedMedianGapMs)}. Queries until the cursor wraps to the first query: ${cycle.queriesUntilWrap ?? '—'}. Worker reported ${cycle.reportedQueryCount ?? 'no'} queries. Cursor updated ${formatIst(cycle.cursorUpdatedAt)}.`}
            />
          ))}
          <Stat
            label="Unopened hits in cap-saturated windows"
            value={formatInt(stats.remaining.unopenedCapHits)}
            detail={`${formatInt(stats.remaining.capSaturatedWindows)} latest query windows hit the page cap. ${formatInt(stats.remaining.unopenedRateLimitHits)} further hits were left by a rate limit in windows that were not also cap-saturated. These are documents inside those queries, not repos left on GitHub. Sample size ${formatInt(stats.remaining.latestWindows)}${stats.remaining.latestWindowsTruncated ? ' (truncated at 2,000)' : ''}.`}
          />
        </div>
        <div className="mt-4">
          <Table
            headers={['When (IST)', 'Lane', 'Query', 'Surface', 'Window', 'Fetched', 'GitHub reported', 'Pages', 'Unopened', 'Why']}
            rows={stats.remaining.capRows.map((row) => [
              formatIst(row.ranAt),
              row.lane,
              row.queryKey,
              row.surface,
              row.cursorWindow,
              formatInt(row.hitsFetched),
              row.reportedTotal == null ? 'not stored' : formatInt(row.reportedTotal),
              row.pagesScanned == null ? '—' : formatInt(row.pagesScanned),
              row.unopenedHits == null ? '—' : formatInt(row.unopenedHits),
              row.unopenedReason ?? (row.capSaturated ? 'cap' : row.rateLimited ? 'rate-limit' : '')
            ])}
          />
        </div>
      </Section>

      <Section id="repos" title="Repositories">
        <p className="mb-3 text-sm leading-6 text-slate-400">
          Unique owner/name values already stored on promo codes and sightings. Newly seen means the earliest stored appearance is inside the window. Followed repos are the direct-poll queue. Watchlist repos come from watchlist.json.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Repos on promo codes" value={formatInt(stats.repos.promoRepos)} />
          <Stat label="Repos on sightings" value={formatInt(stats.repos.sightingRepos)} />
          <Stat label="Union of stored repos" value={formatInt(stats.repos.unionRepos)} detail={`${formatInt(stats.repos.seenBeforeToday)} first seen before today IST. ${formatInt(stats.repos.newToday)} first seen today. ${formatInt(stats.repos.newInRange)} first seen in the selected range.`} />
          <Stat label="Followed repos never polled" value={formatInt(stats.followed.neverPolled)} detail={`${formatInt(stats.followed.total)} followed. ${formatInt(stats.followed.newInRange)} new in range. ${formatInt(stats.followed.polledInRange)} polled in range. A full visit is ${stats.followed.passesForFullVisit ?? '—'} watchlist passes (${formatDurationMs(stats.followed.fullVisitMs)}). Last poll ${formatIst(stats.followed.lastPolledAt)}.`} />
        </div>
        <div className="mt-4">
          <Table
            headers={['Watchlist repo', 'Last scan (IST)', 'Hits on last scan', 'New codes on last scan']}
            rows={stats.watchlist.lastByRepo.map((row) => [row.repo, formatIst(row.lastScanAt), row.hitsFound == null ? 'no scan stored' : formatInt(row.hitsFound), row.newCodes == null ? '—' : formatInt(row.newCodes)])}
          />
          <p className="mt-2 text-xs text-slate-500">{formatInt(stats.watchlist.configured.length)} configured. {formatInt(stats.watchlist.scannedInRange)} distinct watchlist repos scanned in the selected range.</p>
        </div>
      </Section>

      <Section id="tokens" title="Token consumption">
        <p className="mb-3 text-sm leading-6 text-slate-400">{stats.honesty.historicalTokens} Cached tokens are stored as reported. For gpt-6-luna they are billed as a subset of input tokens at the input rate.</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Requests" value={formatInt(stats.tokens.requests)} detail={`${formatInt(stats.tokens.success)} success, ${formatInt(stats.tokens.timeout)} timeout, ${formatInt(stats.tokens.error)} error.`} />
          <Stat label="Input tokens" value={formatInt(stats.tokens.promptTokens)} />
          <Stat label="Output tokens" value={formatInt(stats.tokens.completionTokens)} detail={`${formatInt(stats.tokens.cachedTokens)} cached input tokens.`} />
          <Stat label="Estimated cost" value={formatUsd(stats.tokens.estimatedCostUsd)} detail={`${formatInt(stats.tokens.pricedRequests)} priced requests. ${formatInt(stats.tokens.unpricedRequests)} requests have no configured dollar rate and are excluded from this total.`} />
        </div>
        <div className="mt-4 grid gap-4">
          <Table
            headers={['Model', 'Rate']}
            rows={stats.tokens.rates.map((rate) => [rate.model, rate.priced ? `$${rate.inputPerMillion}/M input, $${rate.cachedPerMillion}/M cached, $${rate.outputPerMillion}/M output. ${rate.note}` : rate.note])}
          />
          <Table
            headers={['Model', 'Requests', 'Input', 'Output', 'Cached', 'Est. cost', 'Success', 'Timeout', 'Error']}
            rows={stats.tokens.byModel.map((row) => [row.model, formatInt(row.requests), formatInt(row.promptTokens), formatInt(row.completionTokens), formatInt(row.cachedTokens), row.costEstimated ? formatUsd(row.estimatedCostUsd) : 'not priced', formatInt(row.success), formatInt(row.timeout), formatInt(row.error)])}
          />
          <Table
            headers={['Day (IST)', 'Model', 'Requests', 'Input', 'Output', 'Cached', 'Est. cost', 'Success', 'Timeout', 'Error']}
            rows={stats.tokens.byDay.map((row) => [row.bucket, row.model, formatInt(row.requests), formatInt(row.promptTokens), formatInt(row.completionTokens), formatInt(row.cachedTokens), row.costEstimated ? formatUsd(row.estimatedCostUsd) : 'not priced', formatInt(row.success), formatInt(row.timeout), formatInt(row.error)])}
          />
          <p className="text-xs text-slate-500">Hourly rows cover the latest {stats.tokens.hourWindowHours} hours inside the selected range.</p>
          <div className="max-h-96 overflow-y-auto">
            <Table
              headers={['Hour (IST)', 'Model', 'Requests', 'Input', 'Output', 'Cached', 'Est. cost', 'Success', 'Timeout', 'Error']}
              rows={stats.tokens.byHour.map((row) => [row.bucket, row.model, formatInt(row.requests), formatInt(row.promptTokens), formatInt(row.completionTokens), formatInt(row.cachedTokens), row.costEstimated ? formatUsd(row.estimatedCostUsd) : 'not priced', formatInt(row.success), formatInt(row.timeout), formatInt(row.error)])}
            />
          </div>
        </div>
      </Section>

      <Section id="gate" title="LLM gate">
        <div className="grid gap-3 md:grid-cols-3">
          <Stat label="Accepted" value={formatInt(stats.gate.accepted)} />
          <Stat label="Rejected" value={formatInt(stats.gate.rejected)} detail="not-public-promo or invalid-code-or-vendor. Rejected text is not stored." />
          <Stat label="Failed" value={formatInt(stats.gate.failed)} detail="Timeouts, empty or truncated output, and transport errors. The reason code is stored, not the response body." />
        </div>
        <div className="mt-4 grid gap-4">
          <Table headers={['Decision', 'Reason', 'Count']} rows={stats.gate.byReason.map((row) => [row.decision, row.reason || '—', formatInt(row.count)])} />
          <Table headers={['Day (IST)', 'Decision', 'Count']} rows={stats.gate.byDay.map((row) => [row.day, row.decision, formatInt(row.count)])} />
          <Table headers={['When (IST)', 'Model', 'Decision', 'Reason']} rows={stats.gate.recent.map((row) => [formatIst(row.decidedAt), row.model, row.decision, row.reason])} />
        </div>
      </Section>

      <Section id="inventory" title="Promo inventory">
        <p className="mb-3 text-sm text-slate-400">Totals are all-time. Period comparisons use Asia/Kolkata day boundaries. Followed-repo polls are stored with source type watchlist.</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Total codes" value={formatInt(stats.inventory.total)} detail={`First seen ${formatIst(stats.inventory.firstSeenAt)}. Last seen ${formatIst(stats.inventory.lastSeenAt)}.`} />
          <Stat label="High / medium / low" value={`${formatInt(stats.inventory.high)} / ${formatInt(stats.inventory.medium)} / ${formatInt(stats.inventory.low)}`} />
          <Stat label="By source" value={`${formatInt(stats.inventory.bySource.commit)} commit`} detail={`${formatInt(stats.inventory.bySource.code)} code, ${formatInt(stats.inventory.bySource.issue)} issue, ${formatInt(stats.inventory.bySource.watchlist)} watchlist.`} />
          <Stat label="By status" value={formatInt(stats.inventory.byStatus.unverified)} detail={`unverified. ${formatInt(stats.inventory.byStatus.active)} active, ${formatInt(stats.inventory.byStatus.likely_expired)} likely expired, ${formatInt(stats.inventory.byStatus.expired)} expired, ${formatInt(stats.inventory.byStatus.flagged)} flagged.`} />
        </div>
        <div className="mt-4">
          <Table
            headers={['Period', 'New codes', 'Seen again', 'New sightings']}
            rows={stats.inventory.periods.map((period) => [period.label, formatInt(period.newCodes), formatInt(period.reseens), formatInt(period.newSightings)])}
          />
        </div>
      </Section>

      <Section id="lanes" title="Scan lanes">
        <p className="mb-3 text-sm leading-6 text-slate-400">{stats.honesty.historicalScans} {stats.honesty.legacyHits} Health uses the worker-reported interval when one exists: stale means the last run is older than three intervals. Cap and rate-limit columns are separate from that label.</p>
        <p className="mb-3 text-sm leading-6 text-slate-400">
          Hits opened in this range: {formatInt(stats.lanes.reduce((sum, lane) => sum + lane.hitsFound, 0))}.
          Stored values not counted as hits opened: {formatInt(stats.lanes.reduce((sum, lane) => sum + lane.legacyHits, 0))} across {formatInt(stats.lanes.reduce((sum, lane) => sum + lane.legacyRuns, 0))} runs.
          A stored value is excluded when the row did not record pages scanned, or when hits_found is above {GITHUB_SEARCH_RESULT_CEILING}.
        </p>
        <Table
          headers={['Lane', 'Health', 'Last scan (IST)', 'Runs', 'Hits opened', 'Stored, not opened', 'New codes', 'Pages', 'Cap hits', 'Rate-limited runs', 'Runs missing page detail']}
          rows={stats.lanes.map((lane) => [lane.label, lane.health, formatIst(lane.lastScanAt), formatInt(lane.runs), formatInt(lane.hitsFound), lane.legacyRuns ? `${formatInt(lane.legacyHits)} in ${formatInt(lane.legacyRuns)} runs` : '0', formatInt(lane.newCodes), formatInt(lane.pagesScanned), formatInt(lane.capHits), formatInt(lane.rateLimitedRuns), formatInt(lane.runsMissingPageDetail)])}
        />
        <div className="mt-4">
          <Table
            headers={['Lane', 'Surface', 'Runs', 'Hits opened', 'Stored, not opened', 'New codes', 'Last scan (IST)']}
            rows={stats.surfaces.map((row) => [row.lane, row.surface, formatInt(row.runs), formatInt(row.hitsFound), row.legacyRuns ? `${formatInt(row.legacyHits)} in ${formatInt(row.legacyRuns)} runs` : '0', formatInt(row.newCodes), formatIst(row.lastScanAt)])}
          />
        </div>
        <div className="mt-4">
          <Table
            headers={['When (IST)', 'Lane', 'Query', 'Surface', 'Mode', 'Window', 'Hits', 'Reported', 'Pages', 'Cap', 'Rate limited', 'New codes']}
            rows={stats.recentRuns.map((row) => [formatIst(row.ranAt), row.lane, row.queryKey, row.surface, row.mode, row.cursorWindow, formatStoredHits(row.hitsFound, row.pagesScanned), row.reportedTotal == null ? '—' : formatInt(row.reportedTotal), row.pagesScanned == null ? '—' : formatInt(row.pagesScanned), row.capSaturated == null ? '—' : String(row.capSaturated), row.rateLimited == null ? '—' : String(row.rateLimited), formatInt(row.newCodes)])}
          />
        </div>
      </Section>

      <Section id="exa" title="Exa discovery">
        <p className="mb-3 text-sm leading-6 text-slate-300">
          {stats.exa.configured == null
            ? 'The worker has not reported whether Exa is configured.'
            : stats.exa.configured
              ? `Exa is configured. Search type ${stats.exa.searchType ?? 'unknown'}, ${stats.exa.numResults ?? '—'} results per request, interval ${formatDurationMs(stats.exa.intervalMs)}, published-within ${stats.exa.publishedWithinDays ?? 'not set'} days, max content age ${stats.exa.maxAgeHours == null ? 'omitted (lite uses cache only)' : `${stats.exa.maxAgeHours} h`}. ${formatInt(stats.exa.queryCount)} vendor queries rotate one per pass.`
              : 'Exa is not configured. The lane stays off until an Exa key is set on the worker. The key is not shown here.'}
        </p>
        <p className="mb-4 text-sm leading-6 text-slate-400">
          Exa has no github category. Requests set includeDomains to github.com, and any result whose host is not github.com is dropped before Pass-1. There is no second page. A full result cap means Exa returned as many rows as requested; raise the result limit up to 100 on the next run if you want a wider sample. Every kept page still goes through Pass-1 and the existing LLM gate.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Last Exa run" value={stats.exa.last ? stats.exa.last.status : 'none'} detail={stats.exa.last ? `${formatIst(stats.exa.last.ranAt)} · ${stats.exa.last.vendor} · ${stats.exa.last.errorCode ?? 'no error'}` : 'No Exa search has been stored.'} />
          <Stat label="Requests in range" value={formatInt(stats.exa.requests)} detail={`${formatInt(stats.exa.runs)} runs, ${formatInt(stats.exa.okRuns)} ok, ${formatInt(stats.exa.errorRuns)} error.`} />
          <Stat label="Results returned" value={formatInt(stats.exa.resultsReturned)} detail={`${formatInt(stats.exa.githubResults)} kept on github.com. ${formatInt(stats.exa.droppedNonGithub)} dropped because the host was not github.com. ${formatInt(stats.exa.resultCapFull)} runs filled the requested result cap.`} />
          <Stat label="Pass-1 / gate / new codes" value={formatInt(stats.exa.pass1Candidates)} detail={`${formatInt(stats.exa.pass1Hits)} pages produced a Pass-1 candidate. Gate accepted ${formatInt(stats.exa.gateAccepted)}, rejected ${formatInt(stats.exa.gateRejected)}, failed ${formatInt(stats.exa.gateFailed)}, bypassed ${formatInt(stats.exa.gateBypassed)} because no LLM was configured. New codes ${formatInt(stats.exa.newCodes)}.`} />
        </div>
        <p className="mt-3 text-sm text-slate-400">
          Estimated Exa cost in range: {stats.exa.unpricedRuns === stats.exa.runs && stats.exa.runs > 0 ? 'not metered yet for these search types.' : formatUsd(stats.exa.costUsd)}
          {' '}{formatInt(stats.exa.responseCostRuns)} runs used costDollars.total from the response. {formatInt(stats.exa.listPriceRuns)} used the published list price. {formatInt(stats.exa.unpricedRuns)} have no price.
        </p>
        <div className="mt-4 grid gap-4">
          <Table
            headers={['Day (IST)', 'Requests', 'Results', 'GitHub kept', 'Pass-1', 'Accepted', 'Rejected', 'Failed', 'New codes', 'Errors', 'Est. cost']}
            rows={stats.exa.byDay.map((row) => [row.bucket, formatInt(row.requests), formatInt(row.resultsReturned), formatInt(row.githubResults), formatInt(row.pass1Candidates), formatInt(row.gateAccepted), formatInt(row.gateRejected), formatInt(row.gateFailed), formatInt(row.newCodes), formatInt(row.errors), formatUsd(row.costUsd)])}
          />
          <div className="max-h-80 overflow-y-auto">
            <Table
              headers={['Hour (IST)', 'Requests', 'Results', 'GitHub kept', 'Pass-1', 'Accepted', 'Rejected', 'Failed', 'New codes', 'Errors', 'Est. cost']}
              rows={stats.exa.byHour.map((row) => [row.bucket, formatInt(row.requests), formatInt(row.resultsReturned), formatInt(row.githubResults), formatInt(row.pass1Candidates), formatInt(row.gateAccepted), formatInt(row.gateRejected), formatInt(row.gateFailed), formatInt(row.newCodes), formatInt(row.errors), formatUsd(row.costUsd)])}
            />
          </div>
          <Table
            headers={['When (IST)', 'Vendor', 'Status', 'Error', 'Type', 'Asked', 'Returned', 'GitHub', 'Pass-1', 'Accepted', 'Rejected', 'Failed', 'Bypassed', 'New', 'Cap full', 'Cost', 'Cost source']}
            rows={stats.exa.recent.map((row) => [formatIst(row.ranAt), row.vendor, row.status, row.errorCode, row.searchType, formatInt(row.numResultsRequested), formatInt(row.resultsReturned), formatInt(row.githubResults), formatInt(row.pass1Candidates), formatInt(row.gateAccepted), formatInt(row.gateRejected), formatInt(row.gateFailed), formatInt(row.gateBypassed), formatInt(row.newCodes), String(row.resultCapFull), row.costUsd == null ? 'not metered' : formatUsd(row.costUsd), row.costSource])}
          />
        </div>
      </Section>

      <Section id="limits" title="GitHub rate limits">
        <p className="mb-3 text-sm text-slate-400">The bucket snapshot is the latest value stored on scan runs, not limited to the date range. Event rows are 429s and primary exhaustion recorded after this version, inside the selected range.</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Stat label="Core" value={bucket(stats)} detail={`Search ${bucketLine(stats, 'search')}. Code search ${bucketLine(stats, 'code_search')}. ${formatInt(stats.rateLimits.latest.recentRuns)} scan rows in the last hour. Last scan ${formatIst(stats.rateLimits.latest.ranAt)}.`} />
          <Stat label="Rate-limit events in range" value={formatInt(stats.rateLimits.eventTotal)} />
          <Stat label="Snapshot time" value={formatIst(stats.rateLimits.latest.rateLimits.core?.at ?? stats.rateLimits.latest.ranAt)} />
        </div>
        <div className="mt-4">
          <Table headers={['Kind', 'Resource', 'Events']} rows={stats.rateLimits.eventsInRange.map((row) => [row.kind, row.resource, formatInt(row.count)])} />
        </div>
      </Section>

      <Section id="config" title="Worker config">
        <p className="mb-3 text-sm leading-6 text-slate-400">
          {stats.runtime.reportedAt
            ? `Reported ${formatIst(stats.runtime.reportedAt)}. Provider ${stats.runtime.llmProvider ?? '—'}, model ${stats.runtime.llmModel ?? '—'}. These are the non-secret settings the worker last wrote. Secrets are not stored in this row.`
            : 'The worker has not reported its running config yet. Intervals and page caps appear after the next worker start.'}
        </p>
        <Table headers={['Setting', 'Value']} rows={configRows(stats.runtime.config)} />
        <p className="mt-3 text-xs text-slate-500">{stats.honesty.noSecrets}</p>
      </Section>

      <section className="mt-8 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <h2 className="text-sm font-semibold text-slate-200">Notes</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-400">
          {stats.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </section>
    </main>
  );
}

function formatStoredHits(hits: number, pagesScanned: number | null): string {
  if (pagesScanned == null || hits > GITHUB_SEARCH_RESULT_CEILING) return `${formatInt(hits)} stored, not opened`;
  return formatInt(hits);
}

function bucketLine(stats: DashboardStats, key: 'search' | 'code_search'): string {
  const value = key === 'search' ? stats.rateLimits.latest.rateLimits.search : stats.rateLimits.latest.rateLimits.code_search;
  if (!value || value.remaining == null) return 'unknown';
  return value.limit == null ? `${value.remaining} remaining` : `${value.remaining}/${value.limit}`;
}

function bucket(stats: DashboardStats): string {
  const value = stats.rateLimits.latest.rateLimits.core;
  if (!value || value.remaining == null) return 'unknown';
  return value.limit == null ? `${formatInt(value.remaining)} remaining` : `${formatInt(value.remaining)}/${formatInt(value.limit)}`;
}
