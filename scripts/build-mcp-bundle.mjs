// Bundle the MCP server and generic runtime into self-contained artifacts.
//
// Why: the Claude/Codex plugin installer copies this package's files into
// ~/.claude/plugins/cache/... WITHOUT node_modules, so a
// `npx tsx src/mcp-server.ts` entry has nothing to import once installed as a
// plugin. The bundles inline every dependency so `.mcp.json` can point a bare
// `node` at the server bundle. The
// committed bundles are the plugin's distribution artifacts. Build locally for
// verification; the main-branch Release workflow commits generated output.
//
// Exceptions that stay external (resolved at runtime, degrade gracefully):
// - playwright: browser driver + downloaded browsers can't live in a bundle.
//   The server only loads it via guarded dynamic import (see lib/browser-kit).
// - single-file-cli: optional page-freeze asset, loaded lazily and only useful
//   when playwright is present.
//
// One seam needs build-time help: modules resolve runtime assets relative to
// their own import.meta.url, and those per-module paths conflict once
// everything shares a bundle's URL. The plugin below rewrites import.meta.url
// in OUR modules to point back at the original source file, relative to the
// bundle location — the src/ tree (including its .php and .json assets) ships
// with the plugin, so the lookups keep working.
import { build } from 'esbuild';
import { relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(pkgRoot, 'src');
const scriptsDir = resolve(pkgRoot, 'scripts');
const serverOutfile = resolve(pkgRoot, 'dist', 'mcp-server.bundle.mjs');
const captureOutfile = resolve(pkgRoot, 'dist', 'capture-engine.bundle.mjs');

/**
 * esbuild can retain literal spaces and tabs before newlines in dependency
 * template literals. Escape them to preserve the string data without making
 * committed bundles fail git diff --check.
 */
async function escapeTrailingBundleWhitespace(path) {
  const bundle = await readFile(path, 'utf8');
  const normalized = bundle.replace(/[ \t]+(?=\r?\n)/g, (whitespace) =>
    [...whitespace].map((character) => (character === '\t' ? '\\t' : '\\x20')).join('')
  );
  if (normalized !== bundle) await writeFile(path, normalized);
}

/** Rewrite import.meta.url in first-party modules to the original file's URL,
 * expressed relative to the bundle so it survives being copied anywhere. */
function perModuleImportMetaUrl(outDir) {
  return {
    name: 'per-module-import-meta-url',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        if (!args.path.startsWith(srcDir) && !args.path.startsWith(scriptsDir)) return undefined;
        const source = await readFile(args.path, 'utf8');
        if (!source.includes('import.meta.url')) return undefined;
        const relFromBundle = relative(outDir, args.path).split('\\').join('/');
        const replacement = `new URL(${JSON.stringify(relFromBundle)}, import.meta.url).href`;
        return {
          contents: source.replaceAll('import.meta.url', replacement),
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
        };
      });
    },
  };
}

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
  external: ['playwright', 'single-file-cli'],
  // Bundled CJS dependencies may call require() at runtime; ESM output has
  // no ambient require, so provide one anchored to the bundle.
  banner: {
    js: [
      "import { createRequire as __bundleCreateRequire } from 'node:module';",
      'const require = __bundleCreateRequire(import.meta.url);',
    ].join('\n'),
  },
};

const server = await build({
  ...shared,
  entryPoints: [resolve(srcDir, 'mcp-server.ts')],
  outfile: serverOutfile,
  plugins: [perModuleImportMetaUrl(dirname(serverOutfile))],
});

const capture = await build({
  ...shared,
  entryPoints: [resolve(srcDir, 'capture-engine.ts')],
  outfile: captureOutfile,
  plugins: [perModuleImportMetaUrl(dirname(captureOutfile))],
});

await Promise.all([escapeTrailingBundleWhitespace(serverOutfile), escapeTrailingBundleWhitespace(captureOutfile)]);

for (const [result, label] of [
  [server, relative(pkgRoot, serverOutfile)],
  [capture, relative(pkgRoot, captureOutfile)],
]) {
  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  process.stdout.write(`build-mcp-bundle: wrote ${label} (${(bytes / 1024 / 1024).toFixed(1)} MB)\n`);
}
