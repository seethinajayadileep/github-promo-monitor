import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildCodeSearchQueries, buildSearchQueries, isFollowableRepo, type StatsCatalog, type VendorConfig } from '@promo/shared';

function readVendors(): string | null {
  const atRoot = path.join(process.cwd(), 'vendors.json');
  const nested = path.join(process.cwd(), '..', '..', 'vendors.json');
  if (existsSync(atRoot)) return readFileSync(atRoot, 'utf8');
  if (existsSync(nested)) return readFileSync(nested, 'utf8');
  return null;
}

function readWatchlist(): string | null {
  const atRoot = path.join(process.cwd(), 'watchlist.json');
  const nested = path.join(process.cwd(), '..', '..', 'watchlist.json');
  if (existsSync(atRoot)) return readFileSync(atRoot, 'utf8');
  if (existsSync(nested)) return readFileSync(nested, 'utf8');
  return null;
}

export function loadStatsCatalog(now = new Date()): StatsCatalog {
  try {
    const vendorText = readVendors();
    const watchlistText = readWatchlist();
    const vendors = vendorText ? JSON.parse(vendorText) as VendorConfig[] : [];
    const watchlist = watchlistText ? JSON.parse(watchlistText) as Array<{ repo: string }> : [];
    return {
      now,
      searchQueryCount: vendors.length ? buildSearchQueries(vendors).length : 0,
      codeQueryCount: vendors.length ? buildCodeSearchQueries(vendors).length : 0,
      watchlistRepos: watchlist.map((entry) => entry.repo).filter((repo) => isFollowableRepo(repo)),
      filesLoaded: vendors.length > 0
    };
  } catch {
    return { now, searchQueryCount: 0, codeQueryCount: 0, watchlistRepos: [], filesLoaded: false };
  }
}
