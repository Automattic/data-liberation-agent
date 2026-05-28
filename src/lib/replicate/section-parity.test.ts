import { describe, it, expect } from 'vitest';
import {
  deriveSectionParityStatus,
  divergenceReasons,
  BG_DELTA_E_FLOOR,
  type SectionParitySignals,
} from './section-parity.js';

const ok = (): SectionParitySignals => ({
  sectionPresent: true,
  bgDeltaE: 1,
  columnCountMatch: true,
  mediaPresent: true,
  fallbackUnstyled: false,
});

describe('divergenceReasons', () => {
  it('no reasons when all signals are good', () => {
    expect(divergenceReasons(ok())).toEqual([]);
  });
  it('flags a dropped section', () => {
    expect(divergenceReasons({ ...ok(), sectionPresent: false })).toContain('section-dropped');
  });
  it('flags a background color delta above the floor', () => {
    expect(divergenceReasons({ ...ok(), bgDeltaE: BG_DELTA_E_FLOOR + 1 })).toContain('bg-color');
  });
  it('does not flag a background delta at or below the floor', () => {
    expect(divergenceReasons({ ...ok(), bgDeltaE: BG_DELTA_E_FLOOR })).not.toContain('bg-color');
  });
  it('flags a column-count flatten', () => {
    expect(divergenceReasons({ ...ok(), columnCountMatch: false })).toContain('column-flatten');
  });
  it('flags dropped media', () => {
    expect(divergenceReasons({ ...ok(), mediaPresent: false })).toContain('media-dropped');
  });
  it('flags an unstyled fallback island', () => {
    expect(divergenceReasons({ ...ok(), fallbackUnstyled: true })).toContain('unstyled-island');
  });
});

describe('deriveSectionParityStatus', () => {
  it('match when no signal diverges', () => {
    expect(deriveSectionParityStatus(ok())).toBe('match');
  });
  it('divergent when a signal diverges and there is no acceptance', () => {
    expect(deriveSectionParityStatus({ ...ok(), columnCountMatch: false })).toBe('divergent');
  });
  it('accepted when a human signs off with a reason', () => {
    expect(
      deriveSectionParityStatus(
        { ...ok(), columnCountMatch: false },
        { by: 'human', proof: 'operator approved the simplified layout' },
      ),
    ).toBe('accepted');
  });
  it('still divergent when a human sign-off has no proof', () => {
    expect(
      deriveSectionParityStatus({ ...ok(), columnCountMatch: false }, { by: 'human', proof: '' }),
    ).toBe('divergent');
  });
  it('rejects class-c acceptance for a structural divergence even with proof', () => {
    // wrong background color is fixable, not a genuine WP rendering constraint —
    // the agent may not self-accept it.
    expect(
      deriveSectionParityStatus(
        { ...ok(), bgDeltaE: 40 },
        { by: 'class-c', proof: 'sampled #aaaaaa vs #bbbbbb' },
      ),
    ).toBe('divergent');
  });
});
