import { countPromoCodes, latestScanStatus, listFilterValues, queryPromoCodes, sanitizeRedeemUrl } from '@promo/shared';
import { CopyButton } from '@/components/CopyButton';
import { StatusToggle } from '@/components/StatusToggle';
import { getPool } from '@/lib/db';
import { clampPage, parseDashboardParams, totalPagesFor } from '@/lib/promoQuery';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const sourceTypes = ['code', 'commit', 'issue', 'watchlist'];
const statuses = ['active', 'unverified', 'likely_expired', 'expired', 'flagged'];

function formatIstDateTime(value: string | Date): string {
  return `${new Date(value).toLocaleString('en-IN', {
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

function formatIstDate(value: string | Date): string {
  return new Date(value).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

function badgeClass(value: string): string {
  if (value === 'high' || value === 'active') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
  if (value === 'medium' || value === 'unverified') return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
  if (value === 'expired' || value === 'flagged') return 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
  return 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
}

function formatBucket(label: string, remaining: number | null | undefined, limit: number | null | undefined): string {
  if (remaining == null) return `${label}: unknown`;
  if (limit == null) return `${label}: ${remaining} remaining`;
  return `${label}: ${remaining}/${limit}`;
}

function Select({ name, value, values, label }: { name: string; value: string; values: readonly string[]; label: string }) {
  return (
    <label className="flex min-w-36 flex-col gap-1 text-xs text-slate-400">
      {label}
      <select name={name} defaultValue={value}>
        <option value="">All</option>
        {values.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  );
}

function pageHref(filters: object, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export default async function DashboardPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const { filters, requestedPage } = parseDashboardParams(searchParams);
  const pool = getPool();
  const total = await countPromoCodes(pool, filters);
  const totalPages = totalPagesFor(total, PAGE_SIZE);
  const currentPage = clampPage(requestedPage, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const [rows, filterValues, worker] = await Promise.all([
    queryPromoCodes(pool, { ...filters, limit: PAGE_SIZE, offset }),
    listFilterValues(pool),
    latestScanStatus(pool)
  ]);
  const rangeStart = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (currentPage - 1) * PAGE_SIZE + rows.length);
  const core = worker.rateLimits?.core;
  const search = worker.rateLimits?.search;
  const codeSearch = worker.rateLimits?.code_search;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Public Promo Code Monitor</h1>
          <p className="mt-1 text-sm text-slate-400">Intentionally shared SaaS, AI, and developer-tool promo codes discovered on public GitHub.</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm">
          <div className="font-medium text-slate-200">Worker status</div>
          <div className="mt-1 text-slate-400">Last scan: {worker.ranAt ? formatIstDateTime(worker.ranAt) : 'no scan recorded'}</div>
          <div className="text-slate-400">{formatBucket('Core API', core?.remaining, core?.limit)}</div>
          <div className="text-slate-400">{formatBucket('Search', search?.remaining, search?.limit)}</div>
          <div className="text-slate-400">{formatBucket('Code search', codeSearch?.remaining, codeSearch?.limit)} · {worker.recentRuns} scans/hour</div>
        </div>
      </header>

      <form className="mb-6 grid gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 md:grid-cols-4 xl:grid-cols-8" method="get">
        <label className="flex flex-col gap-1 text-xs text-slate-400 md:col-span-2">
          Search
          <input name="q" defaultValue={filters.q} placeholder="code, vendor, repo, offer text" />
        </label>
        <Select name="vendor" value={filters.vendor} values={filterValues.vendors} label="Vendor" />
        <Select name="category" value={filters.category} values={filterValues.categories} label="Category" />
        <Select name="sourceType" value={filters.sourceType} values={sourceTypes} label="Source" />
        <label className="flex min-w-36 flex-col gap-1 text-xs text-slate-400">
          Confidence
          <select name="confidence" defaultValue={filters.confidence}>
            <option value="">High & medium</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
            <option value="all">All (incl. low)</option>
          </select>
        </label>
        <Select name="status" value={filters.status} values={statuses} label="Status" />
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Sort
          <select name="sort" defaultValue={filters.sort || 'confidence'}>
            <option value="confidence">High first</option>
            <option value="newest">Newest</option>
            <option value="sightings">Most sightings</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button type="submit">Apply</button>
          <a className="button bg-slate-700 hover:bg-slate-600" href="/">Reset</a>
        </div>
      </form>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
        <div className="flex flex-col gap-2 border-b border-slate-800 px-4 py-3 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {total === 0
              ? '0 results'
              : `Showing ${rangeStart}–${rangeEnd} of ${total} · Page ${currentPage} of ${totalPages}`}
          </div>
          <div className="flex items-center gap-2">
            {currentPage > 1
              ? <a className="button bg-slate-700 hover:bg-slate-600" href={pageHref(filters, currentPage - 1)}>Prev</a>
              : <span className="button bg-slate-800 text-slate-500 hover:bg-slate-800">Prev</span>}
            {currentPage < totalPages
              ? <a className="button bg-slate-700 hover:bg-slate-600" href={pageHref(filters, currentPage + 1)}>Next</a>
              : <span className="button bg-slate-800 text-slate-500 hover:bg-slate-800">Next</span>}
          </div>
        </div>
        <div className="divide-y divide-slate-800">
          {rows.map((row) => {
            const redeemUrl = sanitizeRedeemUrl(row.redeem_url);
            return (
            <article key={row.id} className="grid gap-4 p-4 lg:grid-cols-[1fr_13rem]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-100">{row.vendor}</span>
                  <code className="rounded-md bg-slate-800 px-2 py-1 font-mono text-sm text-sky-200">{row.code}</code>
                  <span className={`rounded-full px-2 py-1 text-xs ring-1 ${badgeClass(row.confidence)}`}>{row.confidence}</span>
                  <span className={`rounded-full px-2 py-1 text-xs ring-1 ${badgeClass(row.status)}`}>{row.status}</span>
                  <span className="rounded-full bg-slate-700/40 px-2 py-1 text-xs text-slate-300">{row.source_type}</span>
                  <span className="rounded-full bg-slate-700/40 px-2 py-1 text-xs text-slate-300">{row.category}</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-300">{row.offer_summary || 'No offer summary extracted.'}</p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                  <span>Repo: {row.repo_full_name}</span>
                  <span>First seen: {formatIstDate(row.first_seen_at)}</span>
                  <span>Last seen: {formatIstDate(row.last_seen_at)}</span>
                  <span>Sightings: {row.sighting_count}</span>
                  {row.expires_at ? <span>Expires: {formatIstDate(row.expires_at)}</span> : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <a className="text-sky-300 hover:text-sky-200" href={row.source_url} target="_blank" rel="noreferrer">GitHub source</a>
                  {redeemUrl ? <a className="text-emerald-300 hover:text-emerald-200" href={redeemUrl} target="_blank" rel="noreferrer">Redeem</a> : null}
                </div>
              </div>
              <div className="flex flex-col items-stretch gap-3 lg:items-end">
                <CopyButton value={row.code} />
                <StatusToggle id={row.id} currentStatus={row.status} />
              </div>
            </article>
            );
          })}
          {!rows.length ? (
            <div className="p-8 text-center text-slate-400">No matching promo codes yet. Once the worker records scan results, they will appear here.</div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
