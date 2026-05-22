import { describe, it, expect } from 'vitest';
import { evaluateResponsive } from './responsive-check.js';

describe('evaluateResponsive', () => {
  it('passes with no overflow and all sections reflowed', () => {
    expect(evaluateResponsive({ scrollWidth: 390, viewportWidth: 390, sectionsTotal: 5, sectionsReflowed: 5 }).ok).toBe(true);
  });
  it('tolerates 1px sub-pixel rounding', () => {
    expect(evaluateResponsive({ scrollWidth: 391, viewportWidth: 390, sectionsTotal: 1, sectionsReflowed: 1 }).ok).toBe(true);
  });
  it('fails on horizontal overflow', () => {
    const r = evaluateResponsive({ scrollWidth: 800, viewportWidth: 390, sectionsTotal: 5, sectionsReflowed: 5 });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /overflow/.test(x))).toBe(true);
  });
  it('fails when a section did not reflow', () => {
    const r = evaluateResponsive({ scrollWidth: 390, viewportWidth: 390, sectionsTotal: 5, sectionsReflowed: 3 });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => /did not reflow/.test(x))).toBe(true);
  });
});
