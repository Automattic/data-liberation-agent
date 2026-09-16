import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { syncVersions } from './sync-versions.mjs';
import { findVersionMismatches } from './check-versions.mjs';
import { MANIFEST_PATHS } from './version-manifests.mjs';

let fixtureDir: string | undefined;
afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

function makeFixture() {
  mkdirSync(join(process.cwd(), '.tmp-test'), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.tmp-test', 'sync-versions-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.2.2' }));
  for (const relPath of MANIFEST_PATHS) {
    mkdirSync(join(dir, dirname(relPath)), { recursive: true });
    // Pretty-printed with a field on either side of "version", like the real manifests.
    writeFileSync(
      join(dir, relPath),
      '{\n  "name": "fixture",\n  "version": "0.1.0",\n  "license": "GPL-2.0-or-later"\n}\n',
    );
  }
  return dir;
}

it('rewrites every manifest to package.json version and reports what changed', () => {
  fixtureDir = makeFixture();

  const result = syncVersions(fixtureDir);

  expect(result).toEqual({ version: '0.2.2', updated: MANIFEST_PATHS });
  expect(findVersionMismatches(fixtureDir).mismatches).toEqual([]);
});

it('only rewrites the version line, leaving the rest of the manifest untouched', () => {
  fixtureDir = makeFixture();

  syncVersions(fixtureDir);

  const manifest = readFileSync(join(fixtureDir, MANIFEST_PATHS[0]), 'utf8');
  expect(manifest).toBe('{\n  "name": "fixture",\n  "version": "0.2.2",\n  "license": "GPL-2.0-or-later"\n}\n');
});

it('reports nothing updated when every manifest already matches', () => {
  fixtureDir = makeFixture();
  syncVersions(fixtureDir);

  const result = syncVersions(fixtureDir);

  expect(result).toEqual({ version: '0.2.2', updated: [] });
});
