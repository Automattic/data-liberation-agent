import { describe, it, expect } from 'vitest';
import { emdashAdapter } from '../../src/adapters/emdash.js';

describe('emdashAdapter', () => {
  it('has id "emdash"', () => {
    expect(emdashAdapter.id).toBe('emdash');
  });

  it('detect() returns false (routing handled by detect-platform.ts)', () => {
    expect(emdashAdapter.detect('https://example.com')).toBe(false);
    expect(emdashAdapter.detect('https://yurulog.liberogic.jp')).toBe(false);
  });
});
