import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const provenance = new URL('provenance.json', root);

if (process.argv[2] === 'clean') {
  rmSync(provenance, { force: true });
} else {
  // Never fall back to environment metadata or a stale identity.
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    throw new Error('Cannot pack release: unable to determine the source commit from git HEAD.', { cause });
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error('Cannot pack release: git HEAD did not resolve to a full commit hash.');
  }
  const { name, version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  writeFileSync(provenance, `${JSON.stringify({ name, version, commit }, null, 2)}\n`);
}
