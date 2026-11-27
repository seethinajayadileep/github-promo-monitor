import { describe, expect, it } from 'vitest';
import { addCommitDateWindow, buildSearchQuery, buildVendorQueryBundles } from '../src/queryPlanner.js';
import type { VendorConfig } from '../src/types.js';

const vendors: VendorConfig[] = Array.from({ length: 14 }, (_, index) => ({
  id: `v${index}`,
  name: `Vendor${index}`,
  category: 'ai',
  domains: [`vendor${index}.com`],
  keywords: [`Vendor ${index}`]
}));

describe('GitHub query planner', () => {
  it('bundles vendors into bounded combined OR queries', () => {
    const bundles = buildVendorQueryBundles(vendors, 7);
    expect(bundles).toHaveLength(7);
    expect(bundles.join(' ')).toContain('Vendor0');
    expect(bundles.join(' ')).toContain('OR');
  });

  it('adds public-sharing cues and commit date windows', () => {
    const query = addCommitDateWindow(buildSearchQuery('(OpenAI)'), '2025-01-01', '2025-01-07');
    expect(query).toContain('"promo code"');
    expect(query).toContain('committer-date:2025-01-01..2025-01-07');
  });
});
