import { describe, it, expect } from 'vitest';
import { buildPageReconstruction } from './reconstruct-pages.js';
import { buildInternalLinkMap } from '../streaming/internal-link-rewrite.js';
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
    // The template renders the page's post_content (real editable block page),
    // between header/footer parts — NOT a wp:pattern ref.
    const tpl = r.files.find((f) => f.path === 'templates/page-about-us.html')!.content;
    expect(tpl).toContain('wp:post-content');
    expect(tpl).not.toContain('wp:pattern');
    expect(tpl).toContain('template-part {"slug":"header"');
    expect(tpl).toContain('template-part {"slug":"footer"');
    // Pattern (theme library) carries the verbatim copy.
    const php = r.files.find((f) => f.path === 'patterns/page-about-us.php')!.content;
    expect(php).toContain('We sell lumber.');
    // post_content is the block markup WITHOUT the PHP doc-comment header, for the WP post.
    expect(r.postContent).toContain('We sell lumber.');
    expect(r.postContent).not.toContain('<?php'); // no PHP in post_content
    expect(r.postContent).not.toContain('Slug: demo-replica'); // no pattern header
  });

  it('renders full-width when the source has a full-bleed section, constrained otherwise (defers to source)', () => {
    // A page with a full-bleed section → full-width (default layout) so the hero
    // and bands stretch edge-to-edge.
    const fw = buildPageReconstruction(
      [section({ headings: ['Hero'], fullBleed: true } as Partial<SectionSpec>)],
      { ...base, slug: 'full' },
    );
    const fwTpl = fw.files.find((f) => f.path === 'templates/page-full.html')!.content;
    expect(fwTpl).toContain('wp:post-content {"layout":{"type":"default"}}');
    expect(fwTpl).not.toContain('wp:post-content {"layout":{"type":"constrained"}}');
    // A page with only boxed content → constrained.
    const cw = buildPageReconstruction([section({ headings: ['Body'], bodyText: ['x'] })], { ...base, slug: 'boxed' });
    const cwTpl = cw.files.find((f) => f.path === 'templates/page-boxed.html')!.content;
    expect(cwTpl).toContain('wp:post-content {"layout":{"type":"constrained"}}');
  });

  it('does NOT force full-width when only a chrome (footer/nav) section is full-bleed', () => {
    // A full-bleed footer/nav band is page chrome, not page content — it must not
    // flip the whole page to full-width.
    const r = buildPageReconstruction(
      [
        section({ headings: ['Body'], bodyText: ['x'] }),
        section({ interactionModel: 'footer', fullBleed: true } as Partial<SectionSpec>),
      ],
      { ...base, slug: 'chrome' },
    );
    const tpl = r.files.find((f) => f.path === 'templates/page-chrome.html')!.content;
    expect(tpl).toContain('wp:post-content {"layout":{"type":"constrained"}}');
  });

  it('an overlay-cover homepage is BOTH full-width and flush-top (the two decisions are independent)', () => {
    const wideHero = { url: 'http://x/wp-content/uploads/hero.jpg', sourceUrl: 'http://x/wp-content/uploads/hero.jpg', alt: '', kind: 'img' as const, width: 1440, height: 796 };
    const r = buildPageReconstruction(
      [section({ interactionModel: 'animated-cover', headings: ['Hero'], images: [wideHero], fullBleed: true } as Partial<SectionSpec>)],
      { ...base, slug: 'home', isHome: true },
    );
    const tpl = r.files.find((f) => f.path === 'templates/front-page.html')!.content;
    expect(tpl).toContain('"className":"site-header-overlay"'); // overlay header
    expect(tpl).toContain('wp:post-content {"layout":{"type":"default"}}'); // full-width
    expect(tpl).toContain('margin-top:0px;padding-top:0px'); // flush-top preserved
  });

  it('emits front-page.html for the home page', () => {
    const r = buildPageReconstruction([section({ headings: ['Home'] })], { ...base, slug: 'home', isHome: true });
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('templates/front-page.html');
    expect(paths).toContain('templates/page-home.html');
  });

  it('wires the overlay header in the template ONLY when the hero is a full-bleed cover', () => {
    const wideHero = { url: 'http://x/wp-content/uploads/hero.jpg', sourceUrl: 'http://x/wp-content/uploads/hero.jpg', alt: '', kind: 'img' as const, width: 1440, height: 796 };
    const coverHome = buildPageReconstruction(
      [section({ interactionModel: 'animated-cover', headings: ['Hero'], bodyText: ['Sub'], images: [wideHero] })],
      { ...base, slug: 'home', isHome: true },
    );
    const coverTpl = coverHome.files.find((f) => f.path === 'templates/front-page.html')!.content;
    expect(coverTpl).toContain('"className":"site-header-overlay"'); // overlay header on the cover-hero homepage

    const plainPage = buildPageReconstruction([section({ headings: ['About'], bodyText: ['copy'] })], { ...base, slug: 'about' });
    const plainTpl = plainPage.files.find((f) => f.path === 'templates/page-about.html')!.content;
    expect(plainTpl).toContain('"slug":"header","tagName":"header"} /-->'); // solid header
    expect(plainTpl).not.toContain('site-header-overlay');
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

  it('rewrites page-body CTA links to local permalinks when a linkMap is supplied', () => {
    const linkMap = buildInternalLinkMap([{ from: '/about-us', to: '/about-us/' }], {
      siteOrigins: ['demo.test'],
    });
    const cta = section({
      headings: ['Learn more'],
      buttons: [{ label: 'About', href: '/about-us' }],
    } as Partial<SectionSpec>);
    const r = buildPageReconstruction([cta], { ...base, slug: 'cta', linkMap });
    // Both the editable post_content and the theme-library pattern get rewritten.
    expect(r.postContent).toContain('href="/about-us/"');
    expect(r.postContent).not.toContain('href="/about-us"');
    const php = r.files.find((f) => f.path === 'patterns/page-cta.php')!.content;
    expect(php).toContain('href="/about-us/"');
    expect(r.gate.ok).toBe(true);
  });

  it('leaves body links untouched when no linkMap is supplied (back-compat)', () => {
    const cta = section({
      headings: ['Learn more'],
      buttons: [{ label: 'About', href: '/about-us' }],
    } as Partial<SectionSpec>);
    const r = buildPageReconstruction([cta], { ...base, slug: 'cta2' });
    expect(r.postContent).toContain('href="/about-us"');
  });
});
