// src/lib/replicate/parity/parity-classify.test.ts
import { describe, it, expect } from 'vitest';
import { classifyDivergences, renderPatchCss, divergenceFingerprint, type Divergence } from './parity-classify.js';

const d = (over: Partial<Divergence>): Divergence => ({
  match: 'section.hero[0]',
  viewport: 'desktop',
  kind: 'prop',
  prop: 'marginBottom',
  source: '88px',
  replica: '0px',
  replicaOnlyClasses: ['wp-block-group'],
  ...over,
});

describe('classifyDivergences', () => {
  it('maps a patchable prop divergence to a css override with the source value', () => {
    const plan = classifyDivergences([d({})]);
    expect(plan.overrides).toEqual([
      {
        selector: 'section.hero',
        occurrence: 0,
        prop: 'margin-bottom',
        value: '88px',
        viewports: ['desktop'],
        cause: 'wp-interference',
      },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it('merges the same divergence across both viewports', () => {
    const plan = classifyDivergences([d({}), d({ viewport: 'mobile' })]);
    expect(plan.overrides).toHaveLength(1);
    expect(plan.overrides[0].viewports).toEqual(['desktop', 'mobile']);
  });

  it('routes rect and missing divergences to unresolved (structural, never guessed)', () => {
    const plan = classifyDivergences([
      d({ kind: 'rect', prop: 'top', source: '100', replica: '160' }),
      d({ kind: 'missing', prop: 'element', source: 'present', replica: 'absent' }),
    ]);
    expect(plan.overrides).toEqual([]);
    expect(plan.unresolved).toHaveLength(2);
    expect(plan.unresolved[0].cause).toBe('structural');
  });

  it('routes font-family divergences to unresolved with the font-authority cause', () => {
    const plan = classifyDivergences([
      d({ prop: 'fontFamily', source: '"Work Sans", sans-serif', replica: 'Helvetica' }),
    ]);
    expect(plan.overrides).toEqual([]);
    expect(plan.unresolved[0].cause).toBe('font-authority'); // product-level fix, not patchable per-site
  });

  it('is idempotent and order-stable (same input → same plan)', () => {
    const input = [d({ prop: 'paddingTop', source: '10px', replica: '0px' }), d({})];
    expect(classifyDivergences(input)).toEqual(classifyDivergences([...input]));
  });
});

describe('renderPatchCss', () => {
  it('renders sorted, viewport-scoped, byte-stable css', () => {
    const plan = classifyDivergences([
      d({ viewport: 'mobile', prop: 'paddingTop', source: '12px', replica: '0px' }),
      d({}),
    ]);
    const css = renderPatchCss(plan);
    expect(css).toContain('/* parity-patch: generated deterministically');
    expect(css).toContain('section.hero { margin-bottom: 88px; }');
    expect(css).toContain('@media (max-width: 767px) {\n  section.hero { padding-top: 12px; }\n}');
    expect(renderPatchCss(plan)).toBe(css); // byte-stable
  });

  it('renders empty string for an empty plan', () => {
    expect(renderPatchCss(classifyDivergences([]))).toBe('');
  });
});

describe('divergenceFingerprint', () => {
  it('is order-insensitive and value-sensitive', () => {
    const a = [d({}), d({ prop: 'paddingTop', source: '1px', replica: '2px' })];
    const b = [...a].reverse();
    expect(divergenceFingerprint(a)).toBe(divergenceFingerprint(b));
    expect(divergenceFingerprint(a)).not.toBe(divergenceFingerprint([d({})]));
  });
});
