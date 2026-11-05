import type { PlatformDetection } from '../../platform/types.js';

export const detection: PlatformDetection = {
  urlPatterns: [ /^https?:\/\/sites\.google\.com(?:[/:]|$)/i ],
  sourceSignals: [
    {
      pattern: /\bdata-legacy-theme-name\s*=/i,
      signal: 'Google Sites legacy theme marker',
    },
    {
      pattern: /<header\b[^>]*\bid=["']atIdViewHeader["']/i,
      signal: 'Google Sites viewer header',
    },
  ],
};
