#!/usr/bin/env node
// src/cli.ts

const args = process.argv.slice(2);

function getArg(name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const val = args[i + 1];
  if (val === undefined || val.startsWith('--')) return null;
  return val;
}

if (args[0] === 'mcp') {
  await import('./mcp-server.js');
} else if (args[0] === '--version') {
  console.log('0.1.0');
} else if (args[0] === '--help' || args.length === 0) {
  console.log(`
  data-liberation — Extract content from closed web platforms into WXR files

  Usage:
    data-liberation <url>              Extract content from a website
    data-liberation inspect <url>      Inspect a site before extraction
    data-liberation import <wxr-file>  Import WXR file to WordPress
    data-liberation qa <wxr-file>        Compare WXR against source site
    data-liberation verify <output-dir>  Verify extraction results
    data-liberation setup                Validate WordPress connection
    data-liberation mcp                Start MCP server (stdio transport)
    data-liberation --version          Show version

  Extract options:
    --output <dir>    Output directory (default: ./output)
    --dry-run         Extract 2-3 pages and report without writing WXR
    --resume          Resume a previous extraction
    --token <token>   API token for platforms requiring auth
    --delay <ms>      Delay between requests (default: 500)
    --verbose         Detailed extraction logging
    --non-interactive Skip the post-extraction import prompt

  Import options:
    --site <domain>       WordPress site domain
    --username <user>     WordPress username
    --token <token>       Application password (or WP_APP_PASSWORD env var)
    --dry-run             Preview without importing
    --delay <ms>          Delay between requests (default: 500)
    --verbose             Detailed logging
    --only <type>         Only import specific type (categories, tags, media, pages, posts, comments, menus)
    --import-authors      Create WordPress users for authors (default: all content owned by you)

  Environment:
    LIBERATION_TOKEN  API token (alternative to --token flag for extraction)
    WP_APP_PASSWORD   WordPress application password (alternative to --token for import)
`);
} else if (args[0] === 'inspect') {
  const url = args[1];
  if (!url || url.startsWith('-')) {
    console.error('Error: URL required. Usage: data-liberation inspect <url>');
    process.exit(1);
  }

  const token = args.includes('--token') ? args[args.indexOf('--token') + 1] : process.env.LIBERATION_TOKEN || null;

  const { runInspect } = await import('./ui/inspect.js');
  runInspect(url, { token });

} else if (args[0] === 'qa') {
  const wxrFile = args[1] || getArg('--wxr');
  if (!wxrFile || wxrFile.startsWith('-')) {
    console.error('Error: WXR file path required. Usage: data-liberation qa <wxr-file> [--fix]');
    process.exit(1);
  }
  const fix = args.includes('--fix');

  const { runQaUi } = await import('./ui/qa.js');
  runQaUi({ wxrFile, fix });

} else if (args[0] === 'verify') {
  const outputDir = args[1] || getArg('--output') || './output';
  if (outputDir.startsWith('-')) {
    console.error('Error: output directory required. Usage: data-liberation verify <output-dir>');
    process.exit(1);
  }

  const { runVerify } = await import('./ui/verify.js');
  runVerify(outputDir);

} else if (args[0] === 'setup') {
  const site = getArg('--site');
  const username = getArg('--username');
  const token = getArg('--token') || process.env.WP_APP_PASSWORD || null;

  const { runSetup } = await import('./ui/setup.js');
  runSetup({ site: site ?? undefined, username: username ?? undefined, token: token ?? undefined });

} else if (args[0] === 'import') {
  const wxrFile = args[1];
  if (!wxrFile || wxrFile.startsWith('-')) {
    console.error('Error: WXR file path required. Run with --help for usage.');
    process.exit(1);
  }

  const site = getArg('--site');
  const username = getArg('--username');
  const token = getArg('--token') || process.env.WP_APP_PASSWORD || null;
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const rawDelay = getArg('--delay') ? parseInt(getArg('--delay')!, 10) : 500;
  const delay = Number.isNaN(rawDelay) ? 500 : rawDelay;
  const only = getArg('--only');
  const importAuthors = args.includes('--import-authors');

  if (!site) {
    console.error('Error: --site is required. Run with --help for usage.');
    process.exit(1);
  }
  if (!username) {
    console.error('Error: --username is required. Run with --help for usage.');
    process.exit(1);
  }
  if (!token) {
    console.error('Error: --token or WP_APP_PASSWORD env var is required. Run with --help for usage.');
    process.exit(1);
  }

  const { runImport } = await import('./ui/import.js');
  runImport({ wxrFile, site: site as string, username: username as string, token: token as string, dryRun, delay, verbose, only, importAuthors });
} else {
  const url = args.find((a: string) => !a.startsWith('-'));
  if (!url) {
    console.error('Error: URL required. Run with --help for usage.');
    process.exit(1);
  }

  const outputDir = getArg('--output') || './output';
  const dryRun = args.includes('--dry-run');
  const resume = args.includes('--resume');
  const verbose = args.includes('--verbose');
  const rawDelay = getArg('--delay') ? parseInt(getArg('--delay')!, 10) : 500;
  const delay = Number.isNaN(rawDelay) ? 500 : rawDelay;
  const token = getArg('--token') || process.env.LIBERATION_TOKEN || null;
  const cdpPort = getArg('--cdp-port') ? parseInt(getArg('--cdp-port')!, 10) : null;
  const nonInteractive = args.includes('--non-interactive');

  const { runDiscover } = await import('./ui/discover.js');
  runDiscover(url, { outputDir, dryRun, resume, verbose, delay, token, cdpPort, nonInteractive });
}
