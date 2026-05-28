import { describe, it, expect } from 'vitest';
import { measureSectionCoverage } from './section-coverage.js';

// Fictional content — no real source-site data (project convention).
describe('measureSectionCoverage', () => {
  it('reports full coverage when all captured text and images appear in the markup', () => {
    const cov = measureSectionCoverage(
      { texts: ['Handmade tables', 'Built to last'], imageUrls: ['/wp-content/uploads/a.jpg'] },
      '<h2>Handmade tables</h2><p>Built to last</p><img src="/wp-content/uploads/a.jpg"/>',
    );
    expect(cov.textCoverage).toBe(1);
    expect(cov.missingImages).toEqual([]);
    expect(cov.lost).toBe(false);
  });

  it('flags lost when a captured image is missing from the render (media-first)', () => {
    const cov = measureSectionCoverage(
      { texts: ['Gallery'], imageUrls: ['/wp-content/uploads/a.jpg', '/wp-content/uploads/b.jpg'] },
      '<h2>Gallery</h2><img src="/wp-content/uploads/a.jpg"/>',
    );
    expect(cov.missingImages).toEqual(['/wp-content/uploads/b.jpg']);
    expect(cov.lost).toBe(true);
  });

  it('flags lost only when text coverage drops below the 0.5 floor (badly broken)', () => {
    const cov = measureSectionCoverage(
      { texts: ['one', 'two', 'three', 'four', 'five'], imageUrls: [] },
      '<p>one</p>', // 1/5 = 0.2 coverage, below the 0.5 floor
    );
    expect(cov.textCoverage).toBeCloseTo(0.2, 5);
    expect(cov.lost).toBe(true);
  });

  it('keeps a section with minor-to-moderate text loss structured (no unstyled island)', () => {
    // 3/5 = 0.6 coverage: above the 0.5 floor. A CSS-styled section that merely
    // missed some copy must stay as structured blocks rather than be downgraded to
    // a CSS-less verbatim island (swiftlumber homepage Advantage cards regression).
    const cov = measureSectionCoverage(
      { texts: ['a', 'b', 'c', 'd', 'e'], imageUrls: [] },
      '<p>a</p><p>b</p><p>c</p>',
    );
    expect(cov.textCoverage).toBeCloseTo(0.6, 5);
    expect(cov.lost).toBe(false);
  });

  it('still flags lost just below the floor (under half the text survived)', () => {
    const cov = measureSectionCoverage(
      { texts: ['a', 'b', 'c', 'd', 'e'], imageUrls: [] },
      '<p>a</p><p>b</p>', // 2/5 = 0.4, below 0.5
    );
    expect(cov.textCoverage).toBeCloseTo(0.4, 5);
    expect(cov.lost).toBe(true);
  });

  it('tolerates minor text loss above the floor when no image is missing', () => {
    const cov = measureSectionCoverage(
      { texts: ['a', 'b', 'c', 'd', 'e'], imageUrls: ['/u/x.jpg'] },
      '<p>a</p><p>b</p><p>c</p><p>d</p><img src="/u/x.jpg"/>', // 4/5 = 0.8, image present
    );
    expect(cov.textCoverage).toBeCloseTo(0.8, 5);
    expect(cov.lost).toBe(false);
  });

  it('matches text case-insensitively and ignores whitespace differences', () => {
    const cov = measureSectionCoverage(
      { texts: ['Hello   World'], imageUrls: [] },
      '<p>hello world</p>',
    );
    expect(cov.textCoverage).toBe(1);
    expect(cov.lost).toBe(false);
  });

  it('treats an empty captured section as not lost (nothing to lose)', () => {
    const cov = measureSectionCoverage({ texts: [], imageUrls: [] }, '<div></div>');
    expect(cov.textCoverage).toBe(1);
    expect(cov.lost).toBe(false);
  });
});
