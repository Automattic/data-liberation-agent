// Verify every plugin manifest declares the same version as package.json.
//
// Why: package.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json,
// and gemini-extension.json each carry their own "version" field, and
// nothing mutated them together — package.json sat at 0.1.0 while the
// plugin manifests moved on to 0.2.2 (#235). package.json is the single
// source of truth; run `npm run version:sync` to write it into every
// manifest, and this check fails CI when a manifest still disagrees.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_PATHS } from './version-manifests.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Compare package.json's version (at `rootDir`) against every manifest in
 * MANIFEST_PATHS. Returns the expected version plus a mismatch entry
 * ({ path, found }) for each manifest that disagrees — an empty array means
 * every manifest matches.
 */
export function findVersionMismatches(rootDir) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const expected = pkg.version;
  const mismatches = [];
  for (const relPath of MANIFEST_PATHS) {
    const manifest = JSON.parse(readFileSync(join(rootDir, relPath), 'utf8'));
    if (manifest.version !== expected) {
      mismatches.push({ path: relPath, found: manifest.version });
    }
  }
  return { expected, mismatches };
}

// Only act as a CLI check when run directly (`node scripts/check-versions.mjs`).
// sync-versions.mjs and this file's own test import findVersionMismatches
// without wanting a process.exit as a side effect of the import.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { expected, mismatches } = findVersionMismatches(repoRoot);
  if (mismatches.length > 0) {
    process.stderr.write(
      `Version mismatch: package.json is ${expected}, but:\n` +
        mismatches.map((m) => `  ${m.path} declares ${m.found}\n`).join('') +
        `Run 'npm run version:sync' and commit the result.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`check-versions: package.json and every manifest agree on ${expected}\n`);
}
