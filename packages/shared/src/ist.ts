export const IST_TIME_ZONE = 'Asia/Kolkata';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00+05:30`).getTime());
}

/** Calendar date in Asia/Kolkata, as YYYY-MM-DD. */
export function istDateString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/** Inclusive IST midnight for a YYYY-MM-DD calendar date. */
export function istDayStart(isoDate: string): Date {
  if (!isIsoDate(isoDate)) throw new Error('invalid IST date');
  return new Date(`${isoDate}T00:00:00+05:30`);
}

export function shiftIstDate(isoDate: string, days: number): string {
  const start = istDayStart(isoDate);
  start.setUTCDate(start.getUTCDate() + Math.trunc(days));
  return istDateString(start);
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}
