import { loadDashboardStats, normalizeStatsFilters } from '@promo/shared';
import { StatsDashboard } from '@/components/StatsDashboard';
import { getPool } from '@/lib/db';
import { loadStatsCatalog } from '@/lib/statsCatalog';

export const dynamic = 'force-dynamic';

export default async function StatsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined>;
}) {
  const resolved = await Promise.resolve(searchParams);
  const filters = normalizeStatsFilters({
    from: first(resolved.from),
    to: first(resolved.to),
    lane: first(resolved.lane),
    model: first(resolved.model),
    q: first(resolved.q)
  });
  try {
    const stats = await loadDashboardStats(getPool(), filters, loadStatsCatalog());
    return <StatsDashboard stats={stats} />;
  } catch (error) {
    console.error('stats page failed', error instanceof Error ? error.name : 'error');
    return <StatsDashboard stats={null} />;
  }
}

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
