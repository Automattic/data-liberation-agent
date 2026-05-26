import { describe, it, expect } from 'vitest';
import { buildPageReconstruction } from './reconstruct-pages.js';
import type { SectionSpec } from './section-extract.js';

function section(partial: Partial<SectionSpec>): SectionSpec {
  return {
    sectionIndex: 0,
    interactionModel: 'static',
    top: 0,
    height: 400,
    headings: [],
    bodyText: [],
    buttonLabels: [],
    images: [],
    icons: [],
    backgroundBrightness: 255,
    backgroundColor: 'rgb(255, 255, 255)',
    gradient: null,
    gradientSource: null,
    motionProfile: { motionClass: 'none', signals: [], animatedElements: 0 },
    dividerAbove: null,
    dividerBelow: null,
    layout: { containerWidth: 1200, padding: '0', childLayout: 'stack', columnCount: 1, gap: '0' },
    ...partial,
  } as SectionSpec;
}

describe('buildPageReconstruction', () => {
  const base = { themeSlug: 'demo-replica', title: 'About Us' };

  it('emits a pattern, a per-page template, and a gate report for a content page', () => {
    const r = buildPageReconstruction([section({ headings: ['About Us'], bodyText: ['We sell lumber.'] })], {
      ...base,
      slug: 'about-us',
    });
    expect(r.patternSlug).toBe('demo-replica/page-about-us');
    expect(r.gate.ok).toBe(true);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('patterns/page-about-us.php');
    expect(paths).toContain('templates/page-about-us.html');
    // The template wires the pattern between header/footer parts.
    const tpl = r.files.find((f) => f.path === 'templates/page-about-us.html')!.content;
    expect(tpl).toContain('"slug":"demo-replica/page-about-us"');
    expect(tpl).toContain('template-part {"slug":"header"');
    expect(tpl).toContain('template-part {"slug":"footer"');
    // Pattern carries the verbatim copy.
    const php = r.files.find((f) => f.path === 'patterns/page-about-us.php')!.content;
    expect(php).toContain('We sell lumber.');
  });

  it('emits front-page.html for the home page', () => {
    const r = buildPageReconstruction([section({ headings: ['Home'] })], { ...base, slug: 'home', isHome: true });
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('templates/front-page.html');
    expect(paths).toContain('templates/page-home.html');
  });

  it('includes icon SVG assets the pattern references', () => {
    const s = section({ interactionModel: 'columns', headings: ['Features'] });
    s.cells = [
      { heading: 'A', body: ['a'], image: null, icon: { kind: 'svg', markup: '<svg viewBox="0 0 24 24"><path d="M3 9h4"/></svg>', width: 48, height: 48 }, button: null },
      { heading: 'B', body: ['b'], image: null, icon: { kind: 'svg', markup: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>', width: 48, height: 48 }, button: null },
    ];
    const r = buildPageReconstruction([s], { ...base, slug: 'features' });
    expect(r.iconAssetCount).toBe(2);
    const iconFiles = r.files.filter((f) => f.path.startsWith('assets/icon-'));
    expect(iconFiles).toHaveLength(2);
    expect(iconFiles[0].content).toContain('<svg');
  });

  it('throws on an unsafe slug rather than emitting a bad path', () => {
    expect(() => buildPageReconstruction([section({})], { ...base, slug: '../evil' })).toThrow(/unsafe/);
    expect(() => buildPageReconstruction([section({})], { themeSlug: 'a/b', title: 'x', slug: 'ok' })).toThrow(/unsafe/);
  });
});
