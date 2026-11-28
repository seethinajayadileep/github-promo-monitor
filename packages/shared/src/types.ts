export type SourceType = 'code' | 'commit' | 'issue' | 'watchlist';
export type Confidence = 'high' | 'medium' | 'low';
export type PromoStatus = 'active' | 'unverified' | 'likely_expired' | 'expired' | 'flagged';
export type ScanMode = 'live' | 'backfill';

export interface VendorConfig {
  id: string;
  name: string;
  category: string;
  domains: string[];
  keywords: string[];
}

export interface WatchlistRepo {
  repo: string;
  reason?: string;
}

export interface PromoCandidate {
  vendor: string;
  code: string;
  category: string;
  offerSummary: string;
  redeemUrl?: string;
  sourceUrl: string;
  sourceType: SourceType;
  repoFullName: string;
  sourceDate?: Date;
  confidence: Confidence;
  expiresAt?: Date;
  snippet: string;
  llmContext?: string;
}

export interface ExtractedPromo {
  isPublicPromo: boolean;
  vendor?: string;
  code?: string;
  offerSummary?: string;
  redeemUrl?: string;
  expiresAt?: Date;
  confidence?: Confidence;
}

export interface RateLimitBucket {
  remaining: number | null;
  limit: number | null;
  resource: string;
  at: string | null;
}

export interface ScanRunInsert {
  queryKey: string;
  surface: string;
  mode: ScanMode;
  cursorWindow?: string;
  etag?: string;
  hitsFound: number;
  newCodes: number;
  rateLimitRemaining?: number;
  rateLimitLimit?: number;
  rateLimitResource?: string;
  pagesScanned?: number;
  reportedTotal?: number;
  capSaturated?: boolean;
  rateLimited?: boolean;
  reportedIncomplete?: boolean;
  lane?: string;
}

export interface PromoCodeRow {
  id: number;
  vendor: string;
  code: string;
  category: string;
  offer_summary: string;
  redeem_url: string | null;
  source_url: string;
  source_type: SourceType;
  repo_full_name: string;
  source_date: string | null;
  confidence: Confidence;
  status: PromoStatus;
  expires_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  sighting_count: number;
}
