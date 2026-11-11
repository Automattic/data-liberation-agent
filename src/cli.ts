#!/usr/bin/env node
// src/cli.ts
//
// Four verbs: inspect a source, liberate a site, verify the copy, publish it.
//
import { HELP, version, parseCliOptions } from './options.js';
import { loadExternalPlatforms } from './platform/load-external.js';

const args = process.argv.slice(2);
const SUBCOMMANDS = ['inspect', 'compare', 'publish', 'mcp'];
function isParseableUrl(candidate: string): boolean {
  try { new URL(candidate); return true; } catch { return false; }
}

try {
await main();
} catch (error) {
  const failure = error as { message?: string; code?: string; evidence?: unknown };
  process.stderr.write(failure.code || failure.evidence
    ? `${JSON.stringify({ error: failure.message ?? String(error), ...(failure.code ? { code: failure.code } : {}), ...(failure.evidence ? { evidence: failure.evidence } : {}) })}\n`
    : `${failure.message ?? String(error)}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
if (args[0] !== 'mcp') {
  const { failed } = await loadExternalPlatforms();
  for (const { entry, error } of failed) console.error(`External platform ${entry}: ${error}`);
}
if (args.includes('--help')) {
  // --help always prints usage, whatever precedes it — a subcommand typo
  // like `capture --help` should never reach argument parsing below.
  console.log(HELP);
} else if (args.length === 0) {
  console.log(HELP);
} else if (args[0] === 'mcp') {
  await import('./mcp-server.js');
} else if (args[0] === '--version') {
  console.log(version);
} else if (args[0] === 'compare') {
  const { positional: directory, options } = parseCliOptions('compare', args.slice(1));
  if (!directory) throw new Error('directory required. Usage: data-liberation compare <dir>');
  const { runCompare } = await import('./ui/compare.js');
  const report = await runCompare(directory, options);
  process.exit(report.pass ? 0 : 1);
} else if (args[0] === 'inspect') {
  const { positional: url, options } = parseCliOptions('inspect', args.slice(1));
  if (!url) throw new Error('URL required. Usage: data-liberation inspect <url>');
  try {
    const { inspectSource } = await import('./lib/inspect.js');
    const result = await inspectSource(url, {
      ...options,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else if (args[0] === 'publish') {
  const { positional: directory, options } = parseCliOptions('publish', args.slice(1));
  if (!directory) throw new Error('directory required. Usage: data-liberation publish <dir>');

  const { publishSite } = await import('./ui/publish.js');
  const { PublishError } = await import('./lib/publish/index.js');
  try {
    const result = await publishSite({
      directory,
      ...options as { target: string; token?: string; space?: string },
      log: (message) => process.stderr.write(`${message}\n`),
    });

    console.log(`Published ${result.files} files to ${result.target}.`);
    if (result.accepted !== undefined && result.accepted < result.files) {
      console.log(`Only ${result.accepted} of ${result.files} were accepted by the destination.`);
    }
    if (result.ignored && result.ignored.length > 0) {
      console.log(`Ignored: ${result.ignored.join(', ')}`);
    }
    console.log(`Live: ${result.liveUrl}`);
    if (result.versionUrl) console.log(`Version: ${result.versionUrl}`);
    if (result.spaceId) console.log(`Space: ${result.spaceId}`);
    if (result.private) {
      console.log('This space is private by default, so the live URL returns 403 until access is granted.');
    }
    if (result.claim) {
      if (result.claim.url) console.log(`Claim it to keep it: ${result.claim.url}`);
      if (result.claim.key) console.log(`Claim key: ${result.claim.key}`);
      if (result.claim.expiresAt) console.log(`Claim expires: ${result.claim.expiresAt}`);
    }
    if (result.spaceId) {
      console.log(
        `To add a version to this space, publish again with --space ${result.spaceId}` +
          `${result.claim?.key ? ' and the claim key above as --token' : ' and your --token'}.`
      );
    }
    for (const note of result.notes) console.log(`Note: ${note}`);
  } catch (error) {
    if (error instanceof PublishError) {
      console.error(error.message);
      if (error.requestId) console.error(`Request ID: ${error.requestId}`);
      process.exit(1);
    }
    throw error;
  }
} else {
  // A bare URL means full-site HTML liberation: every retained route becomes a
  // portable local site that runs on its own.
  const { positional: url, options } = parseCliOptions('liberate', args);
  if (!url) {
    console.error('Error: URL required. Run with --help for usage.');
    process.exit(1);
  }
  if (!isParseableUrl(url)) {
    console.error(
      `Error: "${url}" is not a valid URL or a known subcommand (${SUBCOMMANDS.join(', ')}). Run with --help for usage.`,
    );
    process.exit(1);
  }

  const { liberateSite } = await import('./ui/liberate.js');
  const { acquisition } = options;
  const result = await liberateSite({
    ...options as Omit<Parameters<typeof liberateSite>[0], 'url'>,
    url,
    log: (message) => process.stderr.write(`${message}\n`),
  });

  const notes = [
    result.routesSkipped ? `${result.routesSkipped} reused` : '',
    result.routesFailed ? `${result.routesFailed} failed` : '',
    result.routesOmitted ? `${result.routesOmitted} omitted by route budget` : '',
    result.complete ? '' : 'incomplete',
  ].filter(Boolean);
  console.log(
    `${acquisition === 'http' ? 'HTTP review candidate:' : 'Liberated'} ${result.routesCaptured + result.routesSkipped}/${result.routesDiscovered} routes` +
      (notes.length ? ` (${notes.join(', ')})` : ''),
  );
  console.log(result.checkpoint ? `Resumable checkpoint: ${result.outputDir}` : `Site: ${result.websiteDir}`);
  if (!result.complete) {
    const missing = result.unresolvedAnchors.filter((anchor) => anchor.reason === 'target route was not captured').length;
    process.stderr.write(
      missing
        ? `Capture incomplete: ${missing} same-origin link(s) point at routes that were not captured.\n`
        : 'Capture incomplete.\n',
    );
  }

  const server = result.server;
  if (server) {
    console.log(`Serving: ${server.url}`);
    console.log('Press Ctrl+C to stop.');
    const stop = () => {
      void server.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else if (result.checkpoint) {
    process.stderr.write(`Continue with the same output directory and --resume --checkpoint; no site was exported.\n`);
  } else {
    // Guidance goes to stderr so stdout stays the machine-readable result.
    process.stderr.write(acquisition === 'http' ? 'HTTP review candidate: rendering and interactions remain unverified.\n' : `Browse it: data-liberation ${url} --resume --serve\n`);
  }
}
}
