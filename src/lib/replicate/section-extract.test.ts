import { describe, it, expect } from 'vitest';
import { extractSignature } from './section-extract.js';

const HTML = `<!doctype html><html><body>
  <section><h1>Welcome</h1><a class="button">Call us</a></section>
  <section><div class="col"></div><div class="col"></div><div class="col"></div></section>
</body></html>`;

describe('extractSignature', () => {
  it('derives an ordered section-type sequence from saved HTML', () => {
    const sig = extractSignature('https://x/', HTML, 5);
    expect(sig.url).toBe('https://x/');
    expect(sig.sections.map((s) => s.type)).toEqual(['cover-with-headline', 'columns']);
    expect(sig.sections[1].columns).toBe(3);
  });

  it('falls back to a single static section when no landmarks exist', () => {
    const sig = extractSignature('https://x/', '<body><p>hi</p></body>', 1);
    expect(sig.sections.length).toBeGreaterThanOrEqual(1);
  });
});
