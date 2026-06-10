// src/lib/replicate/normalize/segment.test.ts
import { describe, it, expect } from 'vitest';
import { segmentPage } from './segment.js';

describe('segmentPage', () => {
  it('splits chrome from body sections under <main>', () => {
    const html = `<body>
      <header id="masthead"><nav><a href="x.html">X</a></nav></header>
      <main>
        <section id="hero"><h1>Hi</h1></section>
        <section class="features"><h2>Feat</h2></section>
      </main>
      <footer><p>(c)</p></footer>
    </body>`;
    const sections = segmentPage(html);
    expect(sections.find((s) => s.role === 'header')).toBeTruthy();
    expect(sections.find((s) => s.role === 'footer')).toBeTruthy();
    const body = sections.filter((s) => s.role === 'body');
    expect(body.map((s) => s.id)).toEqual(['hero', 'features']);
  });

  it('derives a stable, deterministic id when no id/class is present', () => {
    const html = '<main><section><h2>Pricing Plans</h2></section></main>';
    const a = segmentPage(html);
    const b = segmentPage(html);
    expect(a[0].id).toBe(b[0].id); // deterministic
    expect(a[0].id.length).toBeGreaterThan(0);
  });
});
