import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wpRootFor } from './media-install.js';

describe('wpRootFor — Studio layout detection', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'media-install-wproot-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flat Studio site (wp-content at site root) resolves to the site path itself', () => {
    const sitePath = join(root, 'flat-site');
    mkdirSync(join(sitePath, 'wp-content'), { recursive: true });
    expect(wpRootFor({ kind: 'studio', sitePath })).toBe(sitePath);
  });

  it('nested Studio site (wordpress/wp-content) resolves to the nested wp-root', () => {
    const sitePath = join(root, 'nested-site');
    mkdirSync(join(sitePath, 'wordpress', 'wp-content'), { recursive: true });
    expect(wpRootFor({ kind: 'studio', sitePath })).toBe(join(sitePath, 'wordpress'));
  });

  it('does not invent a phantom wordpress/ subdir for flat sites (regression)', () => {
    const sitePath = join(root, 'flat-site-2');
    mkdirSync(join(sitePath, 'wp-content'), { recursive: true });
    // The previous implementation hardcoded `<sitePath>/wordpress`, which made
    // uploads land in a directory the running flat site never serves.
    expect(wpRootFor({ kind: 'studio', sitePath })).not.toBe(join(sitePath, 'wordpress'));
  });

});
