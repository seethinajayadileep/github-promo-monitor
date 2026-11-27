import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clampPage, parseDashboardParams, totalPagesFor } from '../lib/promoQuery';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(here, '..');

describe('dashboard query parsing and pagination', () => {
  it('parses dashboard filters and requested page', () => {
    const parsed = parseDashboardParams({ q: 'credits', vendor: ['OpenAI'], page: '3', confidence: 'all' });
    expect(parsed.filters).toMatchObject({ q: 'credits', vendor: 'OpenAI', confidence: 'all' });
    expect(parsed.requestedPage).toBe(3);
  });

  it('clamps out-of-range pages before SQL offsets are computed', () => {
    expect(totalPagesFor(75, 50)).toBe(2);
    expect(clampPage(99, 2)).toBe(2);
    expect(clampPage(0, 2)).toBe(1);
    expect(clampPage(1, totalPagesFor(0, 50))).toBe(1);
  });

  it('ships a favicon and icon asset so browsers do not 404 them', () => {
    const favicon = fs.readFileSync(path.join(dashboardRoot, 'app/favicon.ico'));
    expect(favicon.subarray(0, 4).toString('hex')).toBe('00000100');
    expect(fs.existsSync(path.join(dashboardRoot, 'app/icon.svg'))).toBe(true);
  });

  it('keeps StatusToggle synchronized when refreshed props arrive', () => {
    const source = fs.readFileSync(path.join(dashboardRoot, 'components/StatusToggle.tsx'), 'utf8');
    expect(source).toContain('useEffect(() =>');
    expect(source).toContain('setStatus(currentStatus)');
    expect(source).toContain('[currentStatus]');
  });
});
