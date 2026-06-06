import { describe, it, expect } from 'vitest';
import { computeTemplateVariant, variantTemplateSlug } from './page-template-plan.js';
import type { SectionSpec } from './section-extract.js';

// Minimal fictional section. Only the fields the variant calc reads matter.
function section(p: Partial<SectionSpec>): SectionSpec {
  return { selector: '#s', interactionModel: 'static', top: 200, fullBleed: false, ...(p as object) } as SectionSpec;
}

describe('computeTemplateVariant', () => {
  it('standard: boxed content, no cover hero', () => {
    const v = computeTemplateVariant([section({ top: 200 })], /* heroIsCover */ false);
    expect(v).toEqual({ overlayHeader: false, fullWidth: false, key: 'standard' });
  });

  it('full: a non-chrome full-bleed section drives full width', () => {
    const v = computeTemplateVariant([section({ fullBleed: true, interactionModel: 'static' })], false);
    expect(v.fullWidth).toBe(true);
    expect(v.key).toBe('full');
  });

  it('full-bleed footer/nav does NOT trigger full width', () => {
    const v = computeTemplateVariant([section({ fullBleed: true, interactionModel: 'footer' })], false);
    expect(v.fullWidth).toBe(false);
  });

  it('overlay: cover hero flush at the page top', () => {
    const v = computeTemplateVariant([section({ top: 0, fullBleed: true })], true);
    expect(v).toEqual({ overlayHeader: true, fullWidth: true, key: 'overlay-full' });
  });

  it('NO overlay when the source hero sits below a header (heroTop >= 40)', () => {
    const v = computeTemplateVariant([section({ top: 93, fullBleed: false })], true);
    expect(v.overlayHeader).toBe(false);
  });
});

describe('variantTemplateSlug', () => {
  it('standard maps to the bare page-replica slug', () => {
    expect(variantTemplateSlug('standard')).toBe('page-replica');
  });
  it('non-standard keys are suffixed', () => {
    expect(variantTemplateSlug('full')).toBe('page-replica-full');
    expect(variantTemplateSlug('overlay-full')).toBe('page-replica-overlay-full');
  });
});
