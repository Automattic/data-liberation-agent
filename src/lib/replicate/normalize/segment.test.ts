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
    // 'hero' from the id attr; 'feat' from the h2 slug (heading beats class).
    expect(body.map((s) => s.id)).toEqual(['hero', 'feat']);
  });

  it('derives a stable, deterministic id when no id/class is present', () => {
    const html = '<main><section><h2>Pricing Plans</h2></section></main>';
    const a = segmentPage(html);
    const b = segmentPage(html);
    expect(a[0].id).toBe(b[0].id); // deterministic
    expect(a[0].id.length).toBeGreaterThan(0);
  });

  it('dedups duplicate class-derived body ids with ordinal suffixes', () => {
    const html = `<main>
      <section class="card"><p>One</p></section>
      <section class="card"><p>Two</p></section>
    </main>`;
    const body = segmentPage(html).filter((s) => s.role === 'body');
    expect(body.map((s) => s.id)).toEqual(['card', 'card-2']);
  });

  it('does not treat a nested header as page chrome', () => {
    const html = `<body>
      <main>
        <article class="post"><header><h2>Post Title</h2></header><p>Body text</p></article>
      </main>
    </body>`;
    const sections = segmentPage(html);
    expect(sections.find((s) => s.role === 'header')).toBeUndefined();
    const body = sections.filter((s) => s.role === 'body');
    expect(body).toHaveLength(1);
    expect(body[0].html).toContain('<header>');
  });

  it('prefers a heading slug over utility-first classes for the id', () => {
    const html = '<main><div class="flex mt-8"><h2>About Us</h2></div></main>';
    const body = segmentPage(html).filter((s) => s.role === 'body');
    expect(body.map((s) => s.id)).toEqual(['about-us']);
  });

  it('captures a body-direct nav as a chrome section', () => {
    const html = `<body>
      <nav id="main-nav"><a href="a.html">A</a></nav>
      <main><section id="s1"><h2>S</h2></section></main>
    </body>`;
    const navs = segmentPage(html).filter((s) => s.role === 'nav');
    expect(navs).toHaveLength(1);
    expect(navs[0].html).toContain('main-nav');
  });

  it('avoids dedup suffix collision with a pre-existing literal id', () => {
    const html = `<main>
      <section id="card-2"><p>Literal</p></section>
      <section class="card"><p>One</p></section>
      <section class="card"><p>Two</p></section>
    </main>`;
    const body = segmentPage(html).filter((s) => s.role === 'body');
    // The second class-derived "card" must skip the taken "card-2" slot.
    expect(body.map((s) => s.id)).toEqual(['card-2', 'card', 'card-3']);
    expect(new Set(body.map((s) => s.id)).size).toBe(body.length);
  });

  it('emits <main> itself as one body section when it has only loose children', () => {
    const html = '<body><main><h1>Welcome</h1><p>Intro para</p></main></body>';
    const body = segmentPage(html).filter((s) => s.role === 'body');
    expect(body).toHaveLength(1);
    expect(body[0].html).toContain('<h1>Welcome</h1>');
    expect(body[0].html).toContain('<p>Intro para</p>');
  });
});
