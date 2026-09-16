// Every manifest that ships its own "version" field and travels with the
// package as a release artifact (plugin installers copy these verbatim).
// package.json is the single source of truth; see check-versions.mjs and
// sync-versions.mjs.
export const MANIFEST_PATHS = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'gemini-extension.json',
];
