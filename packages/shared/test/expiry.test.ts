import { describe, expect, it } from 'vitest';
import { expiryTransitions } from '../src/expiry.js';

const now = new Date('2026-01-01T00:00:00Z');

describe('daily auto-expiry logic', () => {
  it('marks codes past expires_at as expired', () => {
    expect(expiryTransitions([{ id: 1, status: 'active', expiresAt: '2025-12-31T23:59:59Z', lastSeenAt: now }], now)).toEqual([
      { id: 1, status: 'expired' }
    ]);
  });

  it('does not expire codes with a future expiry', () => {
    expect(expiryTransitions([{ id: 1, status: 'active', expiresAt: '2026-01-02T00:00:00Z', lastSeenAt: now }], now)).toEqual([]);
  });

  it('marks undated codes with no sightings in 45 days as likely_expired', () => {
    expect(expiryTransitions([{ id: 2, status: 'active', expiresAt: null, lastSeenAt: '2025-11-10T00:00:00Z' }], now)).toEqual([
      { id: 2, status: 'likely_expired' }
    ]);
  });

  it('keeps recent undated codes unchanged', () => {
    expect(expiryTransitions([{ id: 2, status: 'active', expiresAt: null, lastSeenAt: '2025-12-20T00:00:00Z' }], now)).toEqual([]);
  });

  it('does not overwrite flagged or already expired rows', () => {
    expect(expiryTransitions([
      { id: 1, status: 'flagged', expiresAt: '2025-01-01T00:00:00Z', lastSeenAt: now },
      { id: 2, status: 'expired', expiresAt: '2025-01-01T00:00:00Z', lastSeenAt: now }
    ], now)).toEqual([]);
  });
});
