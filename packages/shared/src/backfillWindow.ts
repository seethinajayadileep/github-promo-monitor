function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The next backfill window the worker would scan.
 * With a completed window, the next one ends the day before that window's start.
 * With no completed window, it ends today (UTC date) unless startOverride is set.
 */
export function previousBackfillWindow(
  lastWindow: string | undefined,
  days: number,
  now = new Date(),
  startOverride?: string
): { start: string; end: string } {
  const span = Math.max(1, Math.floor(days));
  const end = new Date(now);
  if (startOverride && !lastWindow) {
    end.setTime(new Date(startOverride).getTime());
  } else if (lastWindow) {
    const lastStart = lastWindow.split('..')[0];
    end.setTime(new Date(lastStart).getTime());
    end.setUTCDate(end.getUTCDate() - 1);
  }
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - span + 1);
  return { start: isoDate(start), end: isoDate(end) };
}

export interface BackfillProgress {
  nextWindow: { start: string; end: string } | null;
  windowsRemaining: number;
  calendarDaysFromNextEndToStop: number | null;
  reachedStop: boolean;
}

/** Count date windows whose end is still on or after the stop date. This is calendar work, not a GitHub total. */
export function countBackfillWindowsRemaining(options: {
  lastCompletedWindow?: string;
  daysPerWindow: number;
  stopDate: string;
  now?: Date;
  startOverride?: string;
}): BackfillProgress {
  const stopMs = new Date(options.stopDate).getTime();
  if (!Number.isFinite(stopMs)) {
    return { nextWindow: null, windowsRemaining: 0, calendarDaysFromNextEndToStop: null, reachedStop: false };
  }
  let last = options.lastCompletedWindow;
  let next: { start: string; end: string } | null = null;
  let windows = 0;
  for (let guard = 0; guard < 20000; guard += 1) {
    const window = previousBackfillWindow(last, options.daysPerWindow, options.now ?? new Date(), last ? undefined : options.startOverride);
    if (new Date(window.end).getTime() < stopMs) {
      const calendarDaysFromNextEndToStop = next
        ? Math.max(0, Math.round((new Date(next.end).getTime() - stopMs) / 86_400_000))
        : 0;
      return {
        nextWindow: next,
        windowsRemaining: windows,
        calendarDaysFromNextEndToStop,
        reachedStop: windows === 0
      };
    }
    if (!next) next = window;
    windows += 1;
    last = `${window.start}..${window.end}`;
  }
  return { nextWindow: next, windowsRemaining: windows, calendarDaysFromNextEndToStop: null, reachedStop: false };
}
