import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveInstallThemeSlug,
  resolveInstallThemeSlug,
  themeCacheFlushCommands,
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

describe('themeCacheFlushCommands', () => {
  const cmds = themeCacheFlushCommands();

  it('flushes transients then the object cache before the pattern-file purge', () => {
    expect(cmds[0]).toEqual(['transient', 'delete', '--all']);
    expect(cmds[1]).toEqual(['cache', 'flush']);
  });

  it('explicitly purges the wp_theme_files_patterns transient so re-installed patterns re-register', () => {
    // Regression guard: a newly-added per-page pattern stays UNregistered (its
    // wp:pattern renders empty) unless this DB-backed transient is cleared —
    // `cache flush` alone does not remove it on a non-persistent object cache.
    const dbQuery = cmds.find((c) => c[0] === 'db' && c[1] === 'query');
    expect(dbQuery).toBeDefined();
    expect(dbQuery![2]).toContain('_transient_wp_theme_files_patterns-%');
    expect(dbQuery![2]).toContain('_transient_timeout_wp_theme_files_patterns-%');
    expect(dbQuery![2].startsWith('DELETE FROM wp_options')).toBe(true);
  });

  it('also purges the SITE-transient pattern-file cache (single-site stores it as _site_transient_)', () => {
    // Regression guard: WordPress caches the patterns/*.php file list as a SITE
    // transient. `transient delete --all` does NOT clear site transients on a
    // single-site install, and the regular `_transient_` DELETE misses the
    // `_site_transient_` row — so a freshly-added per-page pattern resolves to
    // an EMPTY wp:pattern (blank page body) until the TTL lapses. Both prefixes
    // must be deleted.
    const dbQuery = cmds.find((c) => c[0] === 'db' && c[1] === 'query');
    expect(dbQuery![2]).toContain('_site_transient_wp_theme_files_patterns-%');
    expect(dbQuery![2]).toContain('_site_transient_timeout_wp_theme_files_patterns-%');
  });

  it('runs the pattern-file purge LAST (after cache flush, so it is not re-populated)', () => {
    const dbIdx = cmds.findIndex((c) => c[0] === 'db');
    const flushIdx = cmds.findIndex((c) => c[0] === 'cache');
    expect(dbIdx).toBeGreaterThan(flushIdx);
  });
});
