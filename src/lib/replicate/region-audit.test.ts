import { describe, it, expect } from 'vitest';
import { reconcileRegions } from './region-audit.js';
import type { SourceLandmark } from './section-extract.js';

const L = (o: Partial<SourceLandmark>): SourceLandmark =>
  ({ role: 'section', tag: 'section', selector: 'section', textLength: 200, mediaCount: 1, ...o });

describe('reconcileRegions', () => {
  it('flags an actionable nav that was not placed as chrome', () => {
    const census = [L({ role: 'nav', tag: 'nav', selector: 'nav.site-nav', textLength: 60, mediaCount: 0 })];
    const r = reconcileRegions(census, []); // no header_part placed → nav dropped
    expect(r.unassignedRegions.map((x) => x.role)).toEqual(['nav']);
    expect(r.counts.unassigned).toBe(1);
  });
  it('assigns a nav when a header_part was placed (role join)', () => {
    const census = [L({ role: 'nav', tag: 'nav', selector: 'nav.site-nav', textLength: 60, mediaCount: 0 })];
    const r = reconcileRegions(census, [{ kind: 'header_part', role: 'header' }]);
    expect(r.unassignedRegions).toEqual([]);
    expect(r.assignments[0].kind).toBe('header_part');
  });
  it('marks a skip-link / empty region non_actionable', () => {
    const census = [L({ role: 'nav', tag: 'nav', selector: 'nav.skip', textLength: 14, mediaCount: 0 })];
    const r = reconcileRegions(census, []);
    expect(r.unassignedRegions).toEqual([]);
    expect(r.counts.nonActionable).toBe(1);
  });
  it('assigns main when any body section was placed', () => {
    const census = [L({ role: 'main', tag: 'main', selector: 'main' })];
    const r = reconcileRegions(census, [{ kind: 'page_body_section', selector: 'section#hero' }]);
    expect(r.assignments[0].kind).toBe('page_body_section');
  });
  it('assigns a standalone section by exact selector', () => {
    const census = [L({ selector: 'section#promo' })];
    const r = reconcileRegions(census, [{ kind: 'page_body_section', selector: 'section#promo' }]);
    expect(r.assignments[0].kind).toBe('page_body_section');
    expect(r.unassignedRegions).toEqual([]);
  });
});
