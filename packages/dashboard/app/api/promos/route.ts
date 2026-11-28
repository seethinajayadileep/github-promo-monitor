import { NextResponse } from 'next/server';
import { countPromoCodes, queryPromoCodes, sanitizeRedeemUrl } from '@promo/shared';
import { getPool } from '@/lib/db';
import { clampPage, parseDashboardParams, totalPagesFor } from '@/lib/promoQuery';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  try {
    const searchParams = Object.fromEntries(new URL(request.url).searchParams.entries());
    const { filters, requestedPage } = parseDashboardParams(searchParams);
    const pool = getPool();
    const total = await countPromoCodes(pool, filters);
    const totalPages = totalPagesFor(total, PAGE_SIZE);
    const page = clampPage(requestedPage, totalPages);
    const rows = await queryPromoCodes(pool, {
      ...filters,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE
    });
    return NextResponse.json({
      rows: rows.map((row) => ({ ...row, redeem_url: sanitizeRedeemUrl(row.redeem_url) ?? null })),
      total,
      page,
      totalPages,
      pageSize: PAGE_SIZE
    });
  } catch (error) {
    console.error('promo API database query failed', error);
    return NextResponse.json({ error: 'database query failed' }, { status: 500 });
  }
}
