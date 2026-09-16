// Write package.json's version into every plugin manifest.
//
// package.json is the single source of truth (see scripts/check-versions.mjs
// for the manifest list and why this exists). This only rewrites the
// "version" line, in place, so the rest of each manifest's formatting and
// key order is untouched — run this after bumping package.json's version,
// then commit the manifests alongside it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_PATHS } from './version-manifests.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionLine = /^(\s*"version":\s*)"[^"]*"/m;

/**
 * Rewrite every manifest in MANIFEST_PATHS (at `rootDir`) to package.json's
 * version. Returns the version plus the list of manifest paths actually
 * changed (already-matching manifests are left untouched on disk).
 */
export function syncVersions(rootDir) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const version = pkg.version;
  const updated = [];
  for (const relPath of MANIFEST_PATHS) {
    const absPath = join(rootDir, relPath);
    const original = readFileSync(absPath, 'utf8');
    if (!versionLine.test(original)) {
      throw new Error(`No "version" field found in ${relPath}`);
    }
    const next = original.replace(versionLine, (_match, prefix) => `${prefix}"${version}"`);
    if (next !== original) {
      writeFileSync(absPath, next);
      updated.push(relPath);
    }
  }
  return { version, updated };
}

// Only run as a CLI mutation when invoked directly, not when imported (e.g. by this file's test).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { version, updated } = syncVersions(repoRoot);
  if (updated.length === 0) {
    process.stdout.write(`sync-versions: every manifest already at ${version}\n`);
  } else {
    for (const relPath of updated) process.stdout.write(`sync-versions: ${relPath} -> ${version}\n`);
  }
}
