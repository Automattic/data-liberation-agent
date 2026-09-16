import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { findVersionMismatches } from './check-versions.mjs';
import { MANIFEST_PATHS } from './version-manifests.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let fixtureDir: string | undefined;
afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

/** Write a minimal package.json plus one manifest per MANIFEST_PATHS, each at the given version. */
function writeFixture(rootDir: string, versions: { pkg: string; manifests: string }) {
  writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'fixture', version: versions.pkg }));
  for (const relPath of MANIFEST_PATHS) {
    mkdirSync(join(rootDir, dirname(relPath)), { recursive: true });
    writeFileSync(join(rootDir, relPath), JSON.stringify({ name: 'fixture', version: versions.manifests }));
  }
}

it('reports no mismatches for the real repository', () => {
  // This is the regression itself: package.json (0.1.0) and the plugin
  // manifests (0.2.2) disagreed with nothing to catch it (#235). Reading the
  // actual repo files is what would have failed before the fix.
  expect(findVersionMismatches(repoRoot).mismatches).toEqual([]);
});

it('reports a mismatch for every manifest that disagrees with package.json', () => {
  mkdirSync(join(process.cwd(), '.tmp-test'), { recursive: true });
  fixtureDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'check-versions-'));
  writeFixture(fixtureDir, { pkg: '0.2.2', manifests: '0.1.0' });

  const { expected, mismatches } = findVersionMismatches(fixtureDir);

  expect(expected).toBe('0.2.2');
  expect(mismatches).toEqual(MANIFEST_PATHS.map((path) => ({ path, found: '0.1.0' })));
});

it('reports no mismatches once every manifest matches package.json', () => {
  mkdirSync(join(process.cwd(), '.tmp-test'), { recursive: true });
  fixtureDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'check-versions-'));
  writeFixture(fixtureDir, { pkg: '0.2.2', manifests: '0.2.2' });

  expect(findVersionMismatches(fixtureDir).mismatches).toEqual([]);
});
