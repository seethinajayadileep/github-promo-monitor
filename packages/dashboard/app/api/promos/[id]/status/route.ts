import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { updatePromoStatus, type PromoStatus } from '@promo/shared';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

const statuses = new Set<PromoStatus>(['active', 'unverified', 'likely_expired', 'expired', 'flagged']);

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  const params = await context.params;
  const id = Number.parseInt(params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid promo id' }, { status: 400 });
  }

  let payload: { status?: string; adminSecret?: string };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const configuredSecret = process.env.ADMIN_SECRET;
  if (!configuredSecret || !secretMatches(payload.adminSecret, configuredSecret)) {
    return NextResponse.json({ error: 'invalid admin secret' }, { status: 401 });
  }
  if (!payload.status || !statuses.has(payload.status as PromoStatus)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }

  const updated = await updatePromoStatus(getPool(), id, payload.status as PromoStatus);
  if (!updated) return NextResponse.json({ error: 'promo not found' }, { status: 404 });
  return NextResponse.json({ ok: true, id, status: payload.status });
}
