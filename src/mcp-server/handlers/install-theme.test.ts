import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveInstallThemeSlug,
  resolveInstallThemeSlug,
} from './install-theme.js';

const TMP_ROOT = join(process.cwd(), '.tmp-test', 'install-theme');
mkdirSync(TMP_ROOT, { recursive: true });

describe('deriveInstallThemeSlug', () => {
  it('matches the streaming shell theme slug derived from outputDir', () => {
    expect(deriveInstallThemeSlug('/tmp/www.swiftlumber.com')).toBe('www-swiftlumber-com-replica');
  });
});

describe('resolveInstallThemeSlug', () => {
  it('uses the existing shell theme when the requested slug differs', () => {
    const wpRoot = mkdtempSync(join(TMP_ROOT, 'wp-'));
    try {
      const shellThemeDir = join(
        wpRoot,
        'wp-content',
        'themes',
        'www-swiftlumber-com-replica',
      );
      mkdirSync(shellThemeDir, { recursive: true });
      writeFileSync(join(shellThemeDir, 'style.css'), '/* shell */', 'utf8');

      expect(resolveInstallThemeSlug({
        outputDir: '/tmp/www.swiftlumber.com',
        requestedThemeSlug: 'swiftlumber-com-replica',
        wpRoot,
      })).toBe('www-swiftlumber-com-replica');
    } finally {
      rmSync(wpRoot, { recursive: true, force: true });
    }
  });

  it('respects the requested slug when no shell theme exists', () => {
    const wpRoot = mkdtempSync(join(TMP_ROOT, 'wp-'));
    try {
      expect(resolveInstallThemeSlug({
        outputDir: '/tmp/www.swiftlumber.com',
        requestedThemeSlug: 'swiftlumber-com-replica',
        wpRoot,
      })).toBe('swiftlumber-com-replica');
    } finally {
      rmSync(wpRoot, { recursive: true, force: true });
    }
  });
});
