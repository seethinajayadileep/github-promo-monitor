import { createPool } from '@promo/shared';
import type pg from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var promoPool: pg.Pool | undefined;
}

export function getPool(): pg.Pool {
  if (!global.promoPool) global.promoPool = createPool();
  return global.promoPool;
}
