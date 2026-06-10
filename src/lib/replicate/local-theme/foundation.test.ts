// src/lib/replicate/local-theme/foundation.test.ts
import { describe, it, expect } from 'vitest';
import { buildLocalFoundation } from './foundation.js';

const palette = {
  version: 1 as const,
  sampledUrls: 4,
  colors: [
    { hex: '#f7f2e9', count: 400, urls: 4 }, // cream — lightest, high freq
    { hex: '#0e2a30', count: 380, urls: 4 }, // ink — darkest, high freq
    { hex: '#e2573b', count: 120, urls: 4 }, // coral — saturated accent
    { hex: '#135e6b', count: 90, urls: 4 },  // teal
    { hex: '#00ff00', count: 2, urls: 1 },   // noise — below url floor
  ],
};
const typography = {
  version: 1 as const,
  sampledUrls: 4,
  bySelector: {
    body: [{ fontFamily: '"Work Sans", sans-serif', fontSize: '17px', fontWeight: '400', lineHeight: '28px', urls: 4 }],
    h1: [{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '70px', fontWeight: '900', lineHeight: '76px', urls: 4 }],
  },
};
const breakpoints = { version: 1 as const, sampledUrls: 4, minWidth: [768], maxWidth: [1024] };

describe('buildLocalFoundation', () => {
  const { foundation, footerBgToken, footerTextToken } = buildLocalFoundation({ palette, typography, breakpoints });

  it('picks dark text on light surface with a saturated accent', () => {
    expect(foundation.color?.text?.default?.value).toBe('#0e2a30');
    expect(foundation.color?.surface?.base?.value).toBe('#f7f2e9');
    expect(foundation.color?.accent?.primary?.value).toBe('#e2573b');
    expect(foundation.color?.surface?.inverse?.value).toBe('#0e2a30');
    expect(foundation.color?.text?.inverse?.value).toBe('#f7f2e9');
  });

  it('maps body and display families from typography aggregates', () => {
    expect(foundation.typography?.families?.body?.value).toContain('Work Sans');
    expect(foundation.typography?.families?.display?.value).toContain('Fraunces');
  });

  it('derives button component from the accent', () => {
    expect(foundation.components?.button?.background).toBe('#e2573b');
  });

  it('emits footer tokens for the theme scaffold', () => {
    expect(footerBgToken).toBe('surface-inverse');
    expect(footerTextToken).toBe('text-inverse');
  });

  it('ignores below-floor noise colors and is deterministic', () => {
    const again = buildLocalFoundation({ palette, typography, breakpoints });
    expect(again.foundation).toEqual(foundation);
    expect(JSON.stringify(foundation)).not.toContain('#00ff00');
  });

  it('falls back sanely on empty aggregates', () => {
    const empty = buildLocalFoundation({
      palette: { version: 1, sampledUrls: 0, colors: [] },
      typography: { version: 1, sampledUrls: 0, bySelector: {} },
      breakpoints: { version: 1, sampledUrls: 0, minWidth: [], maxWidth: [] },
    });
    expect(empty.foundation.color?.text?.default?.value).toBeTruthy();   // defaults
    expect(empty.foundation.typography?.families?.body?.value).toBeTruthy();
  });
});
