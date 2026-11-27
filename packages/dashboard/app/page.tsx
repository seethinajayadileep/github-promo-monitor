import { latestScanStatus, listFilterValues, queryPromoCodes } from '@promo/shared';
import { CopyButton } from '@/components/CopyButton';
import { StatusToggle } from '@/components/StatusToggle';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

const sourceTypes = ['code', 'commit', 'issue', 'watchlist'];
const confidenceLevels = ['high', 'medium', 'low'];
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

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function badgeClass(value: string): string {
  if (value === 'high' || value === 'active') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
  if (value === 'medium' || value === 'unverified') return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
  if (value === 'expired' || value === 'flagged') return 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
  return 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
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

export default async function DashboardPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const filters = {
    q: firstParam(searchParams.q),
    vendor: firstParam(searchParams.vendor),
    category: firstParam(searchParams.category),
    sourceType: firstParam(searchParams.sourceType),
    confidence: firstParam(searchParams.confidence),
    status: firstParam(searchParams.status),
    sort: firstParam(searchParams.sort)
  };
  const pool = getPool();
  const [rows, filterValues, worker] = await Promise.all([
    queryPromoCodes(pool, { ...filters, limit: 100 }).catch(() => []),
    listFilterValues(pool).catch(() => ({ vendors: [], categories: [] })),
    latestScanStatus(pool).catch(() => ({ ranAt: null, rateLimitRemaining: null, recentRuns: 0 }))
  ]);

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
          <div className="text-slate-400">GitHub headroom: {worker.rateLimitRemaining ?? 'unknown'} remaining · {worker.recentRuns} scans/hour</div>
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
        <Select name="confidence" value={filters.confidence} values={confidenceLevels} label="Confidence" />
        <Select name="status" value={filters.status} values={statuses} label="Status" />
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Sort
          <select name="sort" defaultValue={filters.sort || 'newest'}>
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
        <div className="border-b border-slate-800 px-4 py-3 text-sm text-slate-400">{rows.length} result{rows.length === 1 ? '' : 's'}</div>
        <div className="divide-y divide-slate-800">
          {rows.map((row) => (
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
                  {row.redeem_url ? <a className="text-emerald-300 hover:text-emerald-200" href={row.redeem_url} target="_blank" rel="noreferrer">Redeem</a> : null}
                </div>
              </div>
              <div className="flex flex-col items-stretch gap-3 lg:items-end">
                <CopyButton value={row.code} />
                <StatusToggle id={row.id} currentStatus={row.status} />
              </div>
            </article>
          ))}
          {!rows.length ? (
            <div className="p-8 text-center text-slate-400">No matching promo codes yet. Once the worker records scan results, they will appear here.</div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
