import { describe, it, expect } from 'vitest';
import { parseBuilderEnvelope } from './builder-envelope.js';

describe('parseBuilderEnvelope', () => {
  it('accepts a valid envelope and defaults flags/notes', () => {
    const r = parseBuilderEnvelope({ patterns: [{ slug: 'site/section-1', php: '<!-- wp:paragraph -->' }] });
    expect(r.ok).toBe(true);
    expect(r.envelope?.patterns).toHaveLength(1);
    expect(r.envelope?.sitewideFlags).toEqual([]);
    expect(r.envelope?.notes).toEqual([]);
  });
  it('rejects a non-object', () => {
    expect(parseBuilderEnvelope('nope').ok).toBe(false);
    expect(parseBuilderEnvelope(null).ok).toBe(false);
  });
  it('rejects a missing patterns array', () => {
    expect(parseBuilderEnvelope({ sitewideFlags: [] }).ok).toBe(false);
  });
  it('rejects a pattern missing slug or php', () => {
    const r = parseBuilderEnvelope({ patterns: [{ slug: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /php must be a string/.test(e))).toBe(true);
  });
  it('rejects non-array sitewideFlags', () => {
    expect(parseBuilderEnvelope({ patterns: [], sitewideFlags: 'x' }).ok).toBe(false);
  });
});
