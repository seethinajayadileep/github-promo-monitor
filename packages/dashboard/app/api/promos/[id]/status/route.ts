import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { updatePromoStatus, type PromoStatus } from '@promo/shared';
import { getPool } from '@/lib/db';

const allowedStatuses = new Set<PromoStatus>(['active', 'unverified', 'likely_expired', 'expired', 'flagged']);

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  let body: { status?: PromoStatus; adminSecret?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const expected = process.env.ADMIN_SECRET;
  if (!expected || !secretMatches(body.adminSecret, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || !body.status || !allowedStatuses.has(body.status)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const updated = await updatePromoStatus(getPool(), id, body.status);
  return updated ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 });
}
