import { NextResponse } from 'next/server';
import { loadDashboardStats, normalizeStatsFilters } from '@promo/shared';
import { getPool } from '@/lib/db';
import { loadStatsCatalog } from '@/lib/statsCatalog';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const filters = normalizeStatsFilters({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      lane: url.searchParams.get('lane') ?? undefined,
      model: url.searchParams.get('model') ?? undefined,
      q: url.searchParams.get('q') ?? undefined
    });
    const stats = await loadDashboardStats(getPool(), filters, loadStatsCatalog());
    return NextResponse.json(stats);
  } catch (error) {
    console.error('stats API failed', error instanceof Error ? error.name : 'error');
    return NextResponse.json({ error: 'stats query failed' }, { status: 500 });
  }
}
