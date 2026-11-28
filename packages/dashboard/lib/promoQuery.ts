export interface DashboardSearchParams {
  q?: string;
  vendor?: string;
  category?: string;
  sourceType?: string;
  confidence?: string;
  status?: string;
  sort?: string;
  page?: string;
}

export function firstParam(value: string | string[] | undefined | null): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export interface ParsedDashboardFilters {
  q: string;
  vendor: string;
  category: string;
  sourceType: string;
  confidence: string;
  status: string;
  sort: string;
}

export function parseDashboardParams(searchParams: Record<string, string | string[] | undefined>): {
  filters: ParsedDashboardFilters;
  requestedPage: number;
} {
  return {
    filters: {
      q: firstParam(searchParams.q),
      vendor: firstParam(searchParams.vendor),
      category: firstParam(searchParams.category),
      sourceType: firstParam(searchParams.sourceType),
      confidence: firstParam(searchParams.confidence),
      status: firstParam(searchParams.status),
      sort: firstParam(searchParams.sort)
    },
    requestedPage: Math.max(1, Number.parseInt(firstParam(searchParams.page), 10) || 1)
  };
}

export function totalPagesFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function clampPage(requestedPage: number, totalPages: number): number {
  return Math.min(Math.max(1, requestedPage), Math.max(1, totalPages));
}
