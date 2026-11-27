import type { PromoStatus } from './types.js';

export interface ExpiryInput {
  id: number | string;
  status: PromoStatus;
  expiresAt?: Date | string | null;
  lastSeenAt: Date | string;
}

export interface ExpiryTransition {
  id: number | string;
  status: 'expired' | 'likely_expired';
}

const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Pure transition rules used by the daily worker job and unit tests. */
export function expiryTransitions(rows: ExpiryInput[], now = new Date()): ExpiryTransition[] {
  const transitions: ExpiryTransition[] = [];
  for (const row of rows) {
    if (row.status === 'flagged' || row.status === 'expired') continue;
    if (row.expiresAt && toDate(row.expiresAt).getTime() <= now.getTime()) {
      transitions.push({ id: row.id, status: 'expired' });
      continue;
    }
    if (!row.expiresAt && now.getTime() - toDate(row.lastSeenAt).getTime() >= FORTY_FIVE_DAYS_MS) {
      transitions.push({ id: row.id, status: 'likely_expired' });
    }
  }
  return transitions;
}
