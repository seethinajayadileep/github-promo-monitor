import { NextResponse } from 'next/server';
import { latestScanStatus } from '@promo/shared';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const worker = await latestScanStatus(getPool());
    return NextResponse.json({ ok: true, database: 'up', worker, checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({
      ok: false,
      database: 'down',
      error: 'database query failed'
    }, { status: 503 });
  }
}
