import { describe, expect, it } from 'vitest';
import { detectBehaviors } from './detect-behaviors.js';

// Fictional source assets (no real-site data).
const REVEAL_CSS = `
html.js section { opacity: 0; transform: translateY(18px); transition: opacity 600ms ease, transform 600ms ease; }
html.js section.is-visible { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { section { opacity: 1; transform: none; transition: none; } }
`;
const REVEAL_JS = `
const obs = new IntersectionObserver((entries) => {
  entries.forEach((e) => e.isIntersecting && e.target.classList.add('is-visible'));
}, { threshold: 0.12 });
document.querySelectorAll('section').forEach((s) => obs.observe(s));
`;
const STICKY_JS = `
window.addEventListener('scroll', () => {
  document.querySelector('header').classList.toggle('is-scrolled', window.scrollY > 24);
});
`;
const STICKY_CSS = `header.is-scrolled { padding: 0.4rem 1.5rem; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }`;
const GAP_JS = `
document.querySelectorAll('nav a').forEach((a) => {
  if (a.getAttribute('href') === location.pathname) a.style.color = 'red';
});
`;

describe('detectBehaviors', () => {
  it('detects reveal with parsed params', () => {
    const d = detectBehaviors({ css: REVEAL_CSS, js: REVEAL_JS });
    expect(d.reveal).toEqual({ kind: 'reveal', threshold: 0.12, translateY: '18px', durationMs: 600 });
    expect(d.gaps).toEqual([]);
  });

  it('detects sticky scroll-toggle with class + offset', () => {
    const d = detectBehaviors({ css: STICKY_CSS, js: STICKY_JS });
    expect(d.sticky).toEqual({ kind: 'sticky', toggleClass: 'is-scrolled', offset: 24 });
  });

  it('defaults reveal params when JS omits them', () => {
    const js = `new IntersectionObserver((es)=>es.forEach((e)=>e.isIntersecting&&e.target.classList.add('is-visible')));document.querySelectorAll('section').forEach((s)=>{});`;
    const d = detectBehaviors({ css: 'html.js section{opacity:0}', js });
    expect(d.reveal).toEqual({ kind: 'reveal', threshold: 0.12, translateY: '0px', durationMs: 600 });
  });

  it('requires BOTH the css gate and the observer js for reveal', () => {
    expect(detectBehaviors({ css: REVEAL_CSS, js: '' }).reveal).toBeUndefined();
    expect(detectBehaviors({ css: '', js: REVEAL_JS }).reveal).toBeUndefined();
  });

  it('requires BOTH the scroll listener and a matching css rule for sticky', () => {
    expect(detectBehaviors({ css: '', js: STICKY_JS }).sticky).toBeUndefined();
    expect(detectBehaviors({ css: STICKY_CSS, js: '' }).sticky).toBeUndefined();
  });

  it('reports unrecognized js as a single gap with an excerpt', () => {
    const d = detectBehaviors({ css: '', js: GAP_JS });
    expect(d.reveal).toBeUndefined();
    expect(d.sticky).toBeUndefined();
    expect(d.gaps).toHaveLength(1);
    expect(d.gaps[0].pattern).toBe('uncatalogued-js');
    expect(d.gaps[0].jsExcerpt).toContain('location.pathname');
  });

  it('mixed source: catalog behaviors detected AND leftover js gapped', () => {
    const d = detectBehaviors({ css: REVEAL_CSS + STICKY_CSS, js: REVEAL_JS + STICKY_JS + GAP_JS });
    expect(d.reveal?.kind).toBe('reveal');
    expect(d.sticky?.kind).toBe('sticky');
    expect(d.gaps).toHaveLength(1);
  });

  it('empty source: nothing detected, no gaps', () => {
    expect(detectBehaviors({ css: '', js: '' })).toEqual({ gaps: [] });
  });

  it('reads reveal params from the gate rule, not earlier decoy rules', () => {
    const decoyCss =
      `nav a { transition: color 160ms ease; transform: translateY(4px); }` + REVEAL_CSS;
    const d = detectBehaviors({ css: decoyCss, js: REVEAL_JS });
    expect(d.reveal).toEqual({ kind: 'reveal', threshold: 0.12, translateY: '18px', durationMs: 600 });
  });

  it('regex literals containing quotes do not swallow gap statements', () => {
    const js = `const re = /['"]/;\n` + REVEAL_JS + `rogueTicker.start({ speedMs: 80 });`;
    const d = detectBehaviors({ css: REVEAL_CSS, js });
    expect(d.reveal?.kind).toBe('reveal');
    expect(d.gaps).toHaveLength(1);
    expect(d.gaps[0].jsExcerpt).toContain('rogueTicker.start');
  });

  it('comment-only js is noise, not a gap', () => {
    expect(detectBehaviors({ css: '', js: '// license header only' })).toEqual({ gaps: [] });
  });
});
