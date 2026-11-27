import { describe, expect, it } from 'vitest';
import { normalizeConfidenceFilter, promoSortClause } from '../src/db.js';

describe('dashboard confidence and sort defaults', () => {
  it('defaults an empty confidence filter to high and medium only', () => {
    expect(normalizeConfidenceFilter()).toBe('high-medium');
    expect(normalizeConfidenceFilter('')).toBe('high-medium');
    expect(normalizeConfidenceFilter('all')).toBe('all');
    expect(normalizeConfidenceFilter('high')).toBe('high');
    expect(normalizeConfidenceFilter('low')).toBe('low');
    expect(normalizeConfidenceFilter('medium')).toBe('medium');
  });

  it('puts high confidence ahead of medium in the default sort', () => {
    expect(promoSortClause('confidence')).toContain("WHEN 'high' THEN 0");
    expect(promoSortClause('confidence')).toContain("WHEN 'medium' THEN 1");
    expect(promoSortClause('newest')).toBe('last_seen_at DESC, id DESC');
    expect(promoSortClause('sightings')).toContain('sighting_count DESC');
  });
});
