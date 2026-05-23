import { describe, it, expect } from 'vitest';
import { validateArtifacts, type ArtifactInput } from './validate-artifacts.js';

const base = (): ArtifactInput => ({
  patterns: [{
    slug: 'site/section-1',
    php: `<!-- wp:heading --><h2>Our Services</h2><!-- /wp:heading -->`,
    spec: { interactionModel: 'cta', expectedText: ['Our Services'], expectedAssets: [] },
  }],
});

describe('validateArtifacts — drift', () => {
  it('passes a clean pattern', () => {
    expect(validateArtifacts(base()).ok).toBe(true);
  });
  it('rejects an unresolved placeholder', () => {
    const input = base();
    input.patterns[0].php = `<h2>{{HEADLINE}}</h2>`;
    const r = validateArtifacts(input);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /placeholder/i.test(e.message))).toBe(true);
  });
  it('rejects a remote image URL', () => {
    const input = base();
    input.patterns[0].php = `<img src="https://cdn.example.com/a.jpg" />`;
    const r = validateArtifacts(input);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /remote/i.test(e.message))).toBe(true);
  });
  it('accepts a WP media-library image URL (migrated content image, not a leak)', () => {
    const input = base();
    input.patterns[0].php = `<!-- wp:image {"id":42} --><figure class="wp-block-image"><img src="http://localhost:8882/wp-content/uploads/2026/05/lumber.jpg" alt="Stacked lumber" class="wp-image-42"/></figure><!-- /wp:image -->`;
    input.patterns[0].spec.interactionModel = 'gallery';
    input.patterns[0].spec.expectedText = ['Stacked lumber'];
    const r = validateArtifacts(input);
    expect(r.errors.some((e) => /remote/i.test(e.message))).toBe(false);
  });
  it('still rejects a remote CDN image even when a media-library image is also present', () => {
    const input = base();
    input.patterns[0].php = `<img src="http://localhost:8882/wp-content/uploads/2026/05/a.jpg" /><img src="https://static.wixstatic.com/media/x~mv2.png" />`;
    input.patterns[0].spec.interactionModel = 'gallery';
    const r = validateArtifacts(input);
    expect(r.errors.some((e) => /remote/i.test(e.message))).toBe(true);
  });
  it('rejects a non-WordPress HTML comment', () => {
    const input = base();
    input.patterns[0].php = `<!-- TODO fix this --><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->`;
    const r = validateArtifacts(input);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /comment/i.test(e.message))).toBe(true);
  });
  it('rejects an invalid interaction model', () => {
    const input = base();
    input.patterns[0].spec.interactionModel = 'bogus-model';
    const r = validateArtifacts(input);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /interaction model/i.test(e.message))).toBe(true);
  });
});

describe('validateArtifacts — security (injection/XSS)', () => {
  const withPhp = (php: string): ArtifactInput => ({
    patterns: [{ slug: 'site/section-1', php, spec: { interactionModel: 'cta', expectedText: [], expectedAssets: [] } }],
  });
  it('rejects a raw PHP tag in emitted markup', () => {
    const r = validateArtifacts(withPhp(`<h2>Hi</h2><?php system($_GET['x']); ?>`));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /php tag|<\?php/i.test(e.message))).toBe(true);
  });
  it('rejects a raw <script> tag', () => {
    const r = validateArtifacts(withPhp(`<h2>Hi</h2><script>alert(1)</script>`));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /script/i.test(e.message))).toBe(true);
  });
  it('rejects an inline event handler attribute', () => {
    const r = validateArtifacts(withPhp(`<img src="x" onerror="alert(1)" />`));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /event handler|on\w+=/i.test(e.message))).toBe(true);
  });
  it('allows the sanctioned esc_url PHP echo for theme assets', () => {
    const r = validateArtifacts(withPhp(
      `<img src="<?php echo esc_url( get_theme_file_uri('assets/img-01.jpg') ); ?>" alt="x" />`));
    expect(r.errors.some((e) => /php tag/i.test(e.message))).toBe(false);
  });
});

describe('validateArtifacts — provenance', () => {
  it('flags a heading not present in spec.expectedText', () => {
    const r = validateArtifacts({ patterns: [{
      slug: 'site/section-1',
      php: `<!-- wp:heading --><h2>Award-Winning Service Since 1998</h2><!-- /wp:heading -->`,
      spec: { interactionModel: 'cta', expectedText: ['Our Services'], expectedAssets: [] },
    }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /not found in source|provenance/i.test(e.message))).toBe(true);
  });
  it('passes when emitted text is a subset of spec text', () => {
    const r = validateArtifacts({ patterns: [{
      slug: 'site/section-1',
      php: `<!-- wp:heading --><h2>Our Services</h2><!-- /wp:heading -->`,
      spec: { interactionModel: 'cta', expectedText: ['Our Services', 'Book now'], expectedAssets: [] },
    }] });
    expect(r.ok).toBe(true);
  });
});

describe('validateArtifacts — security evasions (regression)', () => {
  const withPhp = (php: string): ArtifactInput => ({
    patterns: [{ slug: 'site/section-1', php, spec: { interactionModel: 'cta', expectedText: [], expectedAssets: [] } }],
  });
  it('rejects an UPPERCASE <?PHP tag', () => {
    expect(validateArtifacts(withPhp(`<div><?PHP system($_GET['x']); ?></div>`)).ok).toBe(false);
  });
  it('rejects a short <? tag', () => {
    expect(validateArtifacts(withPhp(`<div><? system($_GET['x']); ?></div>`)).ok).toBe(false);
  });
  it('rejects an event handler with no preceding whitespace', () => {
    expect(validateArtifacts(withPhp(`<a href="x"onclick="alert(1)">y</a>`)).ok).toBe(false);
  });
  it('rejects a <script with a leading space', () => {
    expect(validateArtifacts(withPhp(`<div>< script>alert(1)</script></div>`)).ok).toBe(false);
  });
  it('still allows the sanctioned esc_url echo (case-insensitive strip)', () => {
    const r = validateArtifacts(withPhp(`<img src="<?php echo esc_url( get_theme_file_uri('assets/img-01.jpg') ); ?>" alt="x" />`));
    expect(r.errors.some((e) => /php tag/i.test(e.message))).toBe(false);
  });
});

describe('validateArtifacts — provenance evasions (regression)', () => {
  it('flags an invented heading hidden inside a nested span', () => {
    const r = validateArtifacts({ patterns: [{
      slug: 'site/section-1',
      php: `<!-- wp:heading --><h2><span>Award Winning Since 1998</span></h2><!-- /wp:heading -->`,
      spec: { interactionModel: 'cta', expectedText: ['Our Services'], expectedAssets: [] },
    }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /provenance/i.test(e.message))).toBe(true);
  });
  it('flags a heading whose words are only scattered across spec entries', () => {
    const r = validateArtifacts({ patterns: [{
      slug: 'site/section-1',
      php: `<!-- wp:heading --><h2>Win Award</h2><!-- /wp:heading -->`,
      spec: { interactionModel: 'cta', expectedText: ['we win', 'award every year'], expectedAssets: [] },
    }] });
    expect(r.ok).toBe(false);
  });
});

describe('validateArtifacts — pattern-file header (regression: real builder output)', () => {
  it('allows the standard WP pattern-file PHP doc-comment header', () => {
    const php = `<?php\n/**\n * Title: Hero\n * Slug: site/section-0\n * Categories: featured\n */\n?>\n<!-- wp:heading --><h2>Our Services</h2><!-- /wp:heading -->`;
    const r = validateArtifacts({ patterns: [{
      slug: 'site/section-0', php,
      spec: { interactionModel: 'cover-with-headline', expectedText: ['Our Services'], expectedAssets: [] },
    }] });
    expect(r.ok).toBe(true);
  });
  it('still rejects executable PHP after a doc-comment in the header block', () => {
    const php = `<?php /** Title: x */ system($_GET['x']); ?>\n<!-- wp:paragraph --><p>hi</p><!-- /wp:paragraph -->`;
    const r = validateArtifacts({ patterns: [{
      slug: 'site/section-0', php,
      spec: { interactionModel: 'cta', expectedText: [], expectedAssets: [] },
    }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /php tag/i.test(e.message))).toBe(true);
  });
});
