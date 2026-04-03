# Studio Liberation Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "liberate" capabilities to WordPress Studio — desktop app wizard, CLI command, and AI agent integration — so users can import content from closed platforms into local WordPress sites.

**Architecture:** Studio consumes the `data-liberation` MCP server as a subprocess. A shared `LiberationClient` abstraction wraps the MCP lifecycle and is used by both the desktop app and CLI. The desktop app adds a progressive flow UI to the Add Site dialog. The CLI adds `studio site liberate <url>`. The AI agent gains liberation tools and a system prompt workflow section.

**Tech Stack:** TypeScript, React (Electron renderer), `@modelcontextprotocol/sdk`, Tailwind CSS, WordPress Components (`@wordpress/*`), Vitest

**Spec:** `docs/superpowers/specs/2026-04-03-studio-liberation-integration-design.md`

**Depends on:** The `data-liberation` plugin (Plans 1 + 2) must be published to npm. Studio calls it via `npx data-liberation mcp`.

---

### Task 1: LiberationClient — Shared MCP Client

**Files:**
- Create: `apps/cli/lib/liberation/client.ts`
- Create: `apps/cli/lib/liberation/types.ts`
- Create: `apps/cli/lib/liberation/tests/client.test.ts`

The shared client that both desktop app and CLI use to communicate with the data-liberation MCP server. Manages subprocess lifecycle and exposes typed methods for each tool.

- [ ] **Step 1: Define types**

```ts
// apps/cli/lib/liberation/types.ts

export interface DetectResult {
  url: string;
  platform: 'wix' | 'squarespace' | 'webflow' | 'shopify' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
}

export interface DiscoverResult {
  siteUrl: string;
  platform: string;
  urls: Array<{ url: string; type: string }>;
  navigation: Array<{ text: string; href: string; children?: Array<{ text: string; href: string }> }>;
  siteMeta: { title: string; tagline?: string; language?: string };
  counts: Record<string, number>;
}

export interface InspectResult {
  url: string;
  platform: string;
  confidence: string;
  signals: string[];
  sitemapFound: boolean;
  urlCount: number;
  counts: Record<string, number>;
  probeResults: Array<{
    url: string;
    dataSources: string[];
    contentFound: boolean;
    mediaCount: number;
  }>;
  authRequired: boolean;
  extractionFeasibility: 'ready' | 'needs-auth' | 'needs-browser' | 'limited';
}

export interface QualityScores {
  high: number;
  medium: number;
  low: number;
}

export interface ExtractResult {
  wxrPath: string | null;
  redirectMapPath: string | null;
  outputDir: string;
  summary: {
    pagesExtracted: number;
    postsExtracted: number;
    mediaDownloaded: number;
    mediaFailed: number;
    categoriesFound: number;
    tagsFound: number;
    menuItemsFound: number;
    failedUrls: number;
    qualityScores: QualityScores;
  };
  failures: Array<{ url: string; error: string }>;
  wxrValidation: {
    valid: boolean;
    warnings: string[];
  };
  dryRun: boolean;
}

export interface StatusResult {
  running: boolean;
  processed: number;
  remaining: number;
  failed: number;
  currentUrl?: string;
  elapsedMs?: number;
  estimatedRemainingMs?: number;
}

export interface ExtractOptions {
  outputDir: string;
  token?: string;
  cdpPort?: number;
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface LiberationClient {
  detect(url: string): Promise<DetectResult>;
  discover(url: string, opts?: { token?: string; cdpPort?: number; verbose?: boolean }): Promise<DiscoverResult>;
  inspect(url: string, opts?: { token?: string; cdpPort?: number }): Promise<InspectResult>;
  extract(url: string, opts: ExtractOptions, onProgress?: (message: string) => void): Promise<ExtractResult>;
  status(outputDir: string): Promise<StatusResult>;
  dispose(): Promise<void>;
}
```

- [ ] **Step 2: Write failing tests**

```ts
// apps/cli/lib/liberation/tests/client.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { LiberationClient, DetectResult, DiscoverResult, ExtractResult } from '../types';
import { createMockLiberationClient } from '../client';

describe('MockLiberationClient', () => {
  it('detect returns fixture data', async () => {
    const client = createMockLiberationClient({
      detect: { url: 'https://test.wixsite.com/site', platform: 'wix', confidence: 'high', signals: ['URL contains wix domain'] },
    });
    const result = await client.detect('https://test.wixsite.com/site');
    expect(result.platform).toBe('wix');
    expect(result.confidence).toBe('high');
  });

  it('discover returns fixture data', async () => {
    const client = createMockLiberationClient({
      discover: {
        siteUrl: 'https://test.wixsite.com/site',
        platform: 'wix',
        urls: [{ url: 'https://test.wixsite.com/site', type: 'homepage' }],
        navigation: [],
        siteMeta: { title: 'Test Site' },
        counts: { homepage: 1 },
      },
    });
    const result = await client.discover('https://test.wixsite.com/site');
    expect(result.urls).toHaveLength(1);
    expect(result.siteMeta.title).toBe('Test Site');
  });

  it('extract calls onProgress callback', async () => {
    const progressMessages: string[] = [];
    const client = createMockLiberationClient({
      extract: {
        wxrPath: '/tmp/output.wxr',
        redirectMapPath: '/tmp/redirect-map.json',
        outputDir: '/tmp',
        summary: {
          pagesExtracted: 5, postsExtracted: 10, mediaDownloaded: 20, mediaFailed: 0,
          categoriesFound: 2, tagsFound: 3, menuItemsFound: 4, failedUrls: 0,
          qualityScores: { high: 12, medium: 2, low: 1 },
        },
        failures: [],
        wxrValidation: { valid: true, warnings: [] },
        dryRun: false,
      },
      progressMessages: ['[1/15] https://example.com/', '[2/15] https://example.com/about'],
    });

    const result = await client.extract(
      'https://test.wixsite.com/site',
      { outputDir: '/tmp' },
      (msg) => progressMessages.push(msg),
    );

    expect(result.summary.pagesExtracted).toBe(5);
    expect(progressMessages).toHaveLength(2);
  });

  it('dispose is callable', async () => {
    const client = createMockLiberationClient({});
    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/cli/lib/liberation/tests/client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement LiberationClient + mock factory**

```ts
// apps/cli/lib/liberation/client.ts
import { spawn, type ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  LiberationClient,
  DetectResult,
  DiscoverResult,
  InspectResult,
  ExtractResult,
  StatusResult,
  ExtractOptions,
} from './types';

export function createLiberationClient(): LiberationClient {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  async function ensureConnected(): Promise<Client> {
    if (client) return client;

    transport = new StdioClientTransport({
      command: 'npx',
      args: ['data-liberation', 'mcp'],
    });

    client = new Client(
      { name: 'studio-liberation', version: '1.0.0' },
      { capabilities: {} },
    );

    // Listen for log messages (progress updates)
    client.setNotificationHandler('notifications/message', () => {});

    await client.connect(transport);
    return client;
  }

  async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const c = await ensureConnected();
    const result = await c.callTool({ name, arguments: args });
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '{}';
    return JSON.parse(text) as T;
  }

  return {
    async detect(url: string): Promise<DetectResult> {
      return callTool<DetectResult>('liberate_detect', { url });
    },

    async discover(url, opts = {}): Promise<DiscoverResult> {
      return callTool<DiscoverResult>('liberate_discover', { url, ...opts });
    },

    async inspect(url, opts = {}): Promise<InspectResult> {
      return callTool<InspectResult>('liberate_inspect', { url, ...opts });
    },

    async extract(url, opts, onProgress): Promise<ExtractResult> {
      const c = await ensureConnected();

      // Set up progress listener if callback provided
      if (onProgress) {
        c.setNotificationHandler('notifications/message', (notification: unknown) => {
          const data = (notification as { params?: { data?: string } })?.params?.data;
          if (typeof data === 'string') {
            onProgress(data);
          }
        });
      }

      // SECURITY: never include token in logged/returned data
      const args: Record<string, unknown> = {
        url,
        outputDir: opts.outputDir,
        delay: opts.delay,
        resume: opts.resume,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      };
      if (opts.token) args.token = opts.token;
      if (opts.cdpPort) args.cdpPort = opts.cdpPort;

      return callTool<ExtractResult>('liberate_extract', args);
    },

    async status(outputDir: string): Promise<StatusResult> {
      return callTool<StatusResult>('liberate_status', { outputDir });
    },

    async dispose(): Promise<void> {
      if (client) {
        await client.close();
        client = null;
      }
      if (transport) {
        await transport.close();
        transport = null;
      }
    },
  };
}

// Mock client for tests — inject fixture responses
export function createMockLiberationClient(fixtures: {
  detect?: DetectResult;
  discover?: DiscoverResult;
  inspect?: InspectResult;
  extract?: ExtractResult;
  status?: StatusResult;
  progressMessages?: string[];
}): LiberationClient {
  return {
    async detect() {
      return fixtures.detect ?? { url: '', platform: 'unknown', confidence: 'low', signals: [] };
    },
    async discover() {
      return fixtures.discover ?? { siteUrl: '', platform: 'unknown', urls: [], navigation: [], siteMeta: { title: '' }, counts: {} };
    },
    async inspect() {
      return fixtures.inspect ?? { url: '', platform: 'unknown', confidence: 'low', signals: [], sitemapFound: false, urlCount: 0, counts: {}, probeResults: [], authRequired: false, extractionFeasibility: 'limited' };
    },
    async extract(_url, _opts, onProgress) {
      if (onProgress && fixtures.progressMessages) {
        for (const msg of fixtures.progressMessages) {
          onProgress(msg);
        }
      }
      return fixtures.extract ?? { wxrPath: null, redirectMapPath: null, outputDir: '', summary: { pagesExtracted: 0, postsExtracted: 0, mediaDownloaded: 0, mediaFailed: 0, categoriesFound: 0, tagsFound: 0, menuItemsFound: 0, failedUrls: 0, qualityScores: { high: 0, medium: 0, low: 0 } }, failures: [], wxrValidation: { valid: true, warnings: [] }, dryRun: false };
    },
    async status() {
      return fixtures.status ?? { running: false, processed: 0, remaining: 0, failed: 0 };
    },
    async dispose() {},
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/cli/lib/liberation/tests/client.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cli/lib/liberation/
git commit -m "feat: add LiberationClient with MCP subprocess management and mock factory"
```

---

### Task 2: CLI Command — `studio site liberate`

**Files:**
- Create: `apps/cli/commands/site/liberate.ts`
- Modify: `apps/cli/index.ts` (register command)

- [ ] **Step 1: Implement the liberate command**

```ts
// apps/cli/commands/site/liberate.ts
import path from 'node:path';
import { __ } from '@wordpress/i18n';
import { createLiberationClient } from 'cli/lib/liberation/client';
import { runCommand as runCreateSiteCommand } from 'cli/commands/site/create';
import { sendWpCliCommand } from 'cli/lib/wordpress-server-manager';
import { getSiteByFolder, getSiteUrl } from 'cli/lib/cli-config/sites';
import { STUDIO_SITES_ROOT } from 'cli/lib/site-paths';
import { DEFAULT_PHP_VERSION } from '@studio/common/constants';
import { Logger } from 'cli/logger';
import type { StudioArgv } from 'cli/types';

const logger = new Logger<string>();

export async function runCommand(url: string, options: {
  name?: string;
  outputOnly?: boolean;
  dryRun?: boolean;
  token?: string;
  resume?: boolean;
  verbose?: boolean;
}): Promise<void> {
  const token = options.token || process.env.LIBERATION_TOKEN || undefined;

  const client = createLiberationClient();

  try {
    // Step 1: Detect
    console.log('\n  Detecting platform...');
    const detection = await client.detect(url);
    if (detection.platform === 'unknown') {
      console.log(`  Platform not recognized — extraction may be limited`);
    } else {
      console.log(`  ${detection.platform} (${detection.confidence} confidence)`);
    }

    // Step 2: Discover
    console.log('  Discovering content...');
    const inventory = await client.discover(url, { token, verbose: options.verbose });
    const countStr = Object.entries(inventory.counts)
      .map(([type, count]) => `${count} ${type}s`)
      .join(', ');
    console.log(`  ${countStr}`);

    if (inventory.urls.length === 0) {
      console.log('\n  No content found at this URL.');
      console.log('  The site may be empty, require login, or block automated access.');
      console.log('  Run "studio ai" to troubleshoot with the AI assistant.\n');
      return;
    }

    // Step 3: Determine output directory
    const siteName = options.name || inventory.siteMeta?.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported-site';
    const sitePath = path.join(STUDIO_SITES_ROOT, siteName);
    const outputDir = options.outputOnly
      ? path.resolve(options.name || './liberation-output')
      : path.join(sitePath, 'liberation');

    // Step 4: Extract
    console.log('  Extracting content...');
    const result = await client.extract(url, {
      outputDir,
      token,
      delay: 500,
      resume: options.resume,
      dryRun: options.dryRun,
      verbose: options.verbose,
    }, (message) => {
      process.stdout.write(`\r  ${message}`);
    });

    console.log(''); // newline after progress

    if (options.dryRun) {
      console.log('\n  [DRY RUN] Extraction preview:');
      console.log(`    Pages found: ${result.summary.pagesExtracted}`);
      console.log(`    Posts found: ${result.summary.postsExtracted}`);
      console.log(`    Media found: ${result.summary.mediaDownloaded}`);
      console.log(`    Quality: ${result.summary.qualityScores.high} high, ${result.summary.qualityScores.medium} medium, ${result.summary.qualityScores.low} low\n`);
      return;
    }

    if (options.outputOnly) {
      console.log(`\n  ✓ Extraction complete`);
      console.log(`    WXR: ${result.wxrPath}`);
      console.log(`    Media: ${outputDir}/media/`);
      if (result.redirectMapPath) console.log(`    Redirects: ${result.redirectMapPath}`);
      console.log('');
      return;
    }

    // Step 5: Create site and import
    console.log('  Importing to WordPress...');
    console.log(`    Creating site "${siteName}"...`);
    await runCreateSiteCommand(sitePath, {
      name: inventory.siteMeta?.title || siteName,
      wpVersion: 'latest',
      phpVersion: DEFAULT_PHP_VERSION,
      enableHttps: false,
      noStart: false,
      skipBrowser: true,
      skipLogDetails: true,
    });

    console.log('    Importing WXR...');
    const site = await getSiteByFolder(sitePath);
    await sendWpCliCommand(site, `import ${result.wxrPath} --authors=create`);

    const siteUrl = getSiteUrl(site);

    // Step 6: Summary
    if (result.failures.length === 0) {
      console.log(`\n  ✓ Import complete`);
      console.log(`    ${result.summary.pagesExtracted} pages, ${result.summary.postsExtracted} posts, ${result.summary.mediaDownloaded} images imported as drafts`);
      console.log(`    Site running at ${siteUrl}`);
      console.log('\n  Next steps:');
      console.log(`    studio site start ${siteName}       # if not already running`);
      console.log(`    studio preview create ${siteName}   # push to WordPress.com\n`);
    } else {
      console.log(`\n  ⚠ Import completed with issues`);
      console.log(`    ${result.summary.postsExtracted} posts imported, ${result.summary.mediaDownloaded} images uploaded`);
      console.log(`    ${result.failures.length} items failed:`);
      for (const f of result.failures.slice(0, 10)) {
        console.log(`      ${f.url}: ${f.error}`);
      }
      if (result.failures.length > 10) {
        console.log(`      ... and ${result.failures.length - 10} more`);
      }
      console.log(`\n  Run "studio ai" to troubleshoot with the AI assistant.`);
      console.log(`  Or retry: studio site liberate ${url} --resume\n`);
    }
  } finally {
    await client.dispose();
  }
}

export const registerCommand = (yargs: StudioArgv) => {
  return yargs.command({
    command: 'liberate <url>',
    describe: __('Import content from an existing website into a new WordPress site'),
    builder: (yargs) => {
      return yargs
        .positional('url', {
          type: 'string',
          describe: __('URL of the website to import from'),
          demandOption: true,
        })
        .option('name', {
          type: 'string',
          describe: __('Override site name'),
        })
        .option('output-only', {
          type: 'boolean',
          describe: __('Produce WXR + media only, do not create a WordPress site'),
          default: false,
        })
        .option('dry-run', {
          type: 'boolean',
          describe: __('Extract a few pages and report without writing WXR'),
          default: false,
        })
        .option('token', {
          type: 'string',
          describe: __('API token for platforms requiring auth (also reads LIBERATION_TOKEN env var)'),
        })
        .option('resume', {
          type: 'boolean',
          describe: __('Resume a previous interrupted extraction'),
          default: false,
        })
        .option('verbose', {
          type: 'boolean',
          describe: __('Detailed extraction logging'),
          default: false,
        });
    },
    handler: async (argv) => {
      await runCommand(argv.url as string, {
        name: argv.name as string | undefined,
        outputOnly: argv.outputOnly as boolean,
        dryRun: argv.dryRun as boolean,
        token: argv.token as string | undefined,
        resume: argv.resume as boolean,
        verbose: argv.verbose as boolean,
      });
    },
  });
};
```

- [ ] **Step 2: Register the command in index.ts**

In `apps/cli/index.ts`, add the import and registration alongside existing site commands:

```ts
import { registerCommand as registerLiberateCommand } from 'cli/commands/site/liberate';
// ... in the yargs chain:
.command('site', __('Manage WordPress sites'), (yargs) => {
  // ... existing site subcommands
  registerLiberateCommand(yargs);
  return yargs;
})
```

- [ ] **Step 3: Verify command registers**

Run: `npx studio site liberate --help`
Expected: Help text for the liberate command

- [ ] **Step 4: Commit**

```bash
git add apps/cli/commands/site/liberate.ts apps/cli/index.ts
git commit -m "feat: add 'studio site liberate' CLI command"
```

---

### Task 3: AI Agent — System Prompt + Tool Registration

**Files:**
- Modify: `apps/cli/ai/system-prompt.ts`
- Modify: `apps/cli/ai/tools.ts`

- [ ] **Step 1: Add liberation section to system prompt**

In `apps/cli/ai/system-prompt.ts`, add a new section to the `buildSystemPrompt` function's return string, after the existing tool documentation:

```ts
## Data Liberation

When the user says "liberate", "import from", or "migrate from" followed by a URL:
1. Use liberate_detect to identify the platform
2. Use liberate_discover to inventory the site, show to user
3. Create a local site with site_create
4. Use liberate_extract to extract content (outputDir: site's liberation/ directory)
5. Import the WXR via wp_cli("import <wxrPath> --authors=create")
6. Report the summary to the user

When the user is handed off from the liberation wizard with errors:
- The conversation will be pre-loaded with context about what failed
- Use liberate_extract with resume to retry failed URLs
- Use wp_cli to inspect imported content
- Help the user resolve issues conversationally

Available liberation tools (prefixed with mcp__data-liberation__):
- liberate_detect: Detect the platform of a website
- liberate_discover: Inventory a site's content
- liberate_inspect: Probe a site's extractability
- liberate_extract: Extract all content into WXR + media (long-running)
- liberate_status: Check extraction progress
```

- [ ] **Step 2: Register data-liberation MCP tools**

In `apps/cli/ai/tools.ts`, add the data-liberation tools to the tool registration. The tools are exposed via the data-liberation MCP server — Studio needs to register it as an additional MCP tool provider.

This depends on how Studio currently registers MCP servers. If it uses `createSdkMcpServer()`, add the data-liberation server as a second MCP provider. If it dispatches tools manually, add wrapper functions that call the `LiberationClient`.

```ts
// Add to the tool creation function in tools.ts:
import { createLiberationClient } from 'cli/lib/liberation/client';

// Register liberation tools alongside Studio tools
// The exact integration depends on Studio's MCP architecture —
// either as a second MCP server or as wrapper tools calling LiberationClient
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/ai/system-prompt.ts apps/cli/ai/tools.ts
git commit -m "feat: add liberation workflow to AI agent system prompt and tools"
```

---

### Task 4: Desktop App — Add Site Dialog URL Field

**Files:**
- Modify: `apps/studio/src/hooks/use-add-site.ts`
- Modify: Add Site dialog component (identify exact file by searching for `CreateSiteFormValues` usage)

- [ ] **Step 1: Add sourceUrl to CreateSiteFormValues**

In `apps/studio/src/hooks/use-add-site.ts`, extend the `CreateSiteFormValues` interface:

```ts
export interface CreateSiteFormValues {
  siteName: string;
  sitePath: string;
  phpVersion: SupportedPHPVersion;
  wpVersion: string;
  useCustomDomain: boolean;
  customDomain: string | null;
  enableHttps: boolean;
  adminUsername?: string;
  adminPassword?: string;
  adminEmail?: string;
  sourceUrl?: string; // URL of an existing site to import from
}
```

- [ ] **Step 2: Add URL field to Add Site dialog**

Find the Add Site dialog component (search for where `CreateSiteFormValues` is rendered as a form). Add a new section at the bottom, before the submit button:

```tsx
{/* Import from existing website */}
<div className="border-t border-gray-200 pt-3 mt-3">
  <label className="a8c-subtitle-small block mb-1">
    {__('Import from existing website')}
  </label>
  <input
    type="url"
    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
    placeholder="https://mysite.wixsite.com/blog"
    value={formValues.sourceUrl || ''}
    onChange={(e) => setFormValues({ ...formValues, sourceUrl: e.target.value })}
    onBlur={handleUrlBlur}
  />
  {platformBadge && (
    <span className="text-xs text-gray-500 mt-1 block">
      {platformBadge}
    </span>
  )}
  {urlError && (
    <span className="text-xs text-red-500 mt-1 block">
      {urlError}
    </span>
  )}
  <p className="text-xs text-gray-400 mt-1">
    {__('Supports Wix, Squarespace, Webflow, Shopify')}
  </p>
</div>
```

- [ ] **Step 3: Add URL validation and platform detection**

```ts
const [platformBadge, setPlatformBadge] = useState<string | null>(null);
const [urlError, setUrlError] = useState<string | null>(null);

function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!url.includes('://')) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

async function handleUrlBlur() {
  const raw = formValues.sourceUrl || '';
  setUrlError(null);
  setPlatformBadge(null);

  if (!raw.trim()) return;

  const normalized = normalizeUrl(raw);

  try {
    new URL(normalized);
  } catch {
    setUrlError(__("That doesn't look like a URL"));
    return;
  }

  setFormValues({ ...formValues, sourceUrl: normalized });

  // Platform detection (use LiberationClient)
  try {
    const client = createLiberationClient();
    const result = await client.detect(normalized);
    await client.dispose();

    if (result.platform !== 'unknown') {
      setPlatformBadge(`${result.platform.charAt(0).toUpperCase() + result.platform.slice(1)} detected`);
    } else {
      setPlatformBadge(__('Platform not recognized — extraction may be limited'));
    }
  } catch {
    // Detection failed silently — user can still proceed
  }
}
```

- [ ] **Step 4: Disable submit button after click**

Add state to prevent double-submit:

```ts
const [isSubmitting, setIsSubmitting] = useState(false);

// In the submit handler:
if (isSubmitting) return;
setIsSubmitting(true);
```

- [ ] **Step 5: Route to liberation flow when sourceUrl is set**

In the submit handler, if `formValues.sourceUrl` is set, transition to the liberation flow instead of normal site creation:

```ts
if (formValues.sourceUrl) {
  // Trigger liberation flow (Task 5's component)
  onStartLiberation(formValues.sourceUrl, formValues.siteName);
  return;
}
// ... existing site creation logic
```

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/hooks/use-add-site.ts apps/studio/src/components/
git commit -m "feat: add 'Import from existing website' URL field to Add Site dialog"
```

---

### Task 5: Desktop App — Progressive Flow Component

**Files:**
- Create: `apps/studio/src/components/content-tab-liberation.tsx`
- Create: `apps/studio/src/hooks/use-liberation.ts`

This is the largest task — the progressive flow UI with 5 steps, state machine, progress tracking, and completion states.

- [ ] **Step 1: Implement the liberation state hook**

```ts
// apps/studio/src/hooks/use-liberation.ts
import { useState, useCallback, useRef, useEffect } from 'react';
import { createLiberationClient } from 'cli/lib/liberation/client';
import type { LiberationClient, DetectResult, DiscoverResult, ExtractResult } from 'cli/lib/liberation/types';

export type LiberationStep = 'idle' | 'detecting' | 'discovering' | 'extracting' | 'importing' | 'complete';
export type LiberationStatus = 'pending' | 'in_progress' | 'success' | 'warning' | 'error';

export interface LiberationState {
  step: LiberationStep;
  detection: DetectResult | null;
  inventory: DiscoverResult | null;
  extractResult: ExtractResult | null;
  progress: { current: number; total: number; currentUrl: string } | null;
  error: string | null;
  stepStatuses: Record<LiberationStep, LiberationStatus>;
}

export function useLiberation(sitePath: string) {
  const [state, setState] = useState<LiberationState>({
    step: 'idle',
    detection: null,
    inventory: null,
    extractResult: null,
    progress: null,
    error: null,
    stepStatuses: {
      idle: 'success',
      detecting: 'pending',
      discovering: 'pending',
      extracting: 'pending',
      importing: 'pending',
      complete: 'pending',
    },
  });

  const clientRef = useRef<LiberationClient | null>(null);
  const cancelledRef = useRef(false);

  // Throttle progress updates to 500ms
  const lastProgressUpdate = useRef(0);

  const start = useCallback(async (url: string, opts: { token?: string } = {}) => {
    cancelledRef.current = false;
    const client = createLiberationClient();
    clientRef.current = client;

    const updateStep = (step: LiberationStep, status: LiberationStatus, extra?: Partial<LiberationState>) => {
      setState(prev => ({
        ...prev,
        step,
        stepStatuses: { ...prev.stepStatuses, [step]: status },
        ...extra,
      }));
    };

    try {
      // Step 1: Detect
      updateStep('detecting', 'in_progress');
      const detection = await client.detect(url);
      updateStep('detecting', 'success', { detection });

      if (cancelledRef.current) return;

      // Step 2: Discover
      updateStep('discovering', 'in_progress');
      const inventory = await client.discover(url, { token: opts.token });
      updateStep('discovering', inventory.urls.length > 0 ? 'success' : 'warning', { inventory });

      if (cancelledRef.current || inventory.urls.length === 0) return;

      // Step 3: Extract
      updateStep('extracting', 'in_progress');
      const outputDir = `${sitePath}/liberation`;
      const extractResult = await client.extract(url, {
        outputDir,
        token: opts.token,
        delay: 500,
      }, (message) => {
        const now = Date.now();
        if (now - lastProgressUpdate.current < 500) return;
        lastProgressUpdate.current = now;

        // Parse progress: "[31/59] https://example.com/page"
        const match = message.match(/\[(\d+)\/(\d+)\]\s*(.*)/);
        if (match) {
          setState(prev => ({
            ...prev,
            progress: { current: parseInt(match[1]), total: parseInt(match[2]), currentUrl: match[3] },
          }));
        }
      });

      const extractStatus = extractResult.failures.length > 0 ? 'warning' : 'success';
      updateStep('extracting', extractStatus, { extractResult });

      if (cancelledRef.current) return;

      // Step 4: Import
      updateStep('importing', 'in_progress');
      // Import is handled by the component — it calls wp_cli
      updateStep('importing', 'success');

      // Step 5: Complete
      updateStep('complete', extractStatus);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setState(prev => ({
        ...prev,
        error: errorMsg,
        stepStatuses: { ...prev.stepStatuses, [prev.step]: 'error' },
      }));
    }
  }, [sitePath]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clientRef.current?.dispose();
  }, []);

  const dispose = useCallback(async () => {
    await clientRef.current?.dispose();
    clientRef.current = null;
  }, []);

  return { state, start, cancel, dispose };
}
```

- [ ] **Step 2: Implement the progressive flow component**

```tsx
// apps/studio/src/components/content-tab-liberation.tsx
import { __ } from '@wordpress/i18n';
import { useLiberation, type LiberationStep, type LiberationStatus } from 'src/hooks/use-liberation';
import ProgressBar from 'src/components/progress-bar';
import Button from 'src/components/button';
import { useAuth } from 'src/hooks/use-auth';

// Platform-specific guidance messages
const PLATFORM_GUIDANCE: Record<string, string> = {
  wix: 'Wix sites require a browser for extraction — this may take longer than other platforms.',
  squarespace: 'Your public content will be extracted, no login needed.',
  webflow: 'CMS content will be extracted via the Webflow API.',
  shopify: 'Blog posts and pages will be extracted via the Shopify API.',
  unknown: 'Platform not recognized — extraction may be limited.',
};

interface StepIndicatorProps {
  label: string;
  status: LiberationStatus;
  children?: React.ReactNode;
}

function StepIndicator({ label, status, children }: StepIndicatorProps) {
  const icon = {
    pending: <span className="bg-gray-200 text-gray-500 rounded-full w-5 h-5 flex items-center justify-center text-xs">•</span>,
    in_progress: <span className="bg-blue-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs animate-spin">↻</span>,
    success: <span className="bg-green-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs">✓</span>,
    warning: <span className="bg-amber-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs">!</span>,
    error: <span className="bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs">✗</span>,
  }[status];

  const opacity = status === 'pending' ? 'opacity-35' : '';

  return (
    <div className={`mb-4 ${opacity}`}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </div>
      {children && <div className="ml-7">{children}</div>}
    </div>
  );
}

interface ContentTabLiberationProps {
  sourceUrl: string;
  sitePath: string;
  onComplete: () => void;
  onCancel: () => void;
  onAiHandoff: (context: Record<string, unknown>) => void;
}

export function ContentTabLiberation({
  sourceUrl,
  sitePath,
  onComplete,
  onCancel,
  onAiHandoff,
}: ContentTabLiberationProps) {
  const { state, start, cancel } = useLiberation(sitePath);
  const { isAuthenticated } = useAuth();

  // Start liberation on mount
  useEffect(() => {
    start(sourceUrl);
    return () => { cancel(); };
  }, [sourceUrl]);

  const { stepStatuses, detection, inventory, extractResult, progress, error } = state;

  return (
    <div className="p-6 max-w-lg">
      {/* Step 1: Detect */}
      <StepIndicator label={detection ? `Platform detected: ${detection.platform}` : __('Detecting platform...')} status={stepStatuses.detecting}>
        {detection && (
          <p className="text-xs text-gray-500">{PLATFORM_GUIDANCE[detection.platform] || ''}</p>
        )}
      </StepIndicator>

      {/* Step 2: Inventory */}
      <StepIndicator label={inventory ? `${inventory.urls.length} items found` : __('Discovering content...')} status={stepStatuses.discovering}>
        {inventory && inventory.urls.length > 0 && (
          <div className="bg-gray-50 rounded p-3 text-xs grid grid-cols-2 gap-1">
            {Object.entries(inventory.counts).map(([type, count]) => (
              <div key={type}><span className="text-gray-500">{type}:</span> <strong>{count}</strong></div>
            ))}
          </div>
        )}
        {inventory && inventory.urls.length === 0 && (
          <p className="text-xs text-amber-600">
            {__('No content found. The site may be empty, require login, or block automated access.')}
          </p>
        )}
      </StepIndicator>

      {/* Step 3: Extract */}
      <StepIndicator label={__('Extracting content...')} status={stepStatuses.extracting}>
        {progress && stepStatuses.extracting === 'in_progress' && (
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{progress.current} of {progress.total}</span>
            </div>
            <ProgressBar value={progress.current / progress.total * 100} />
            <p className="text-xs text-gray-400 mt-1 truncate">{progress.currentUrl}</p>
          </div>
        )}
      </StepIndicator>

      {/* Step 4: Import */}
      <StepIndicator label={__('Import to WordPress')} status={stepStatuses.importing} />

      {/* Step 5: Complete */}
      <StepIndicator label={__('Review & publish')} status={stepStatuses.complete}>
        {extractResult && stepStatuses.complete !== 'pending' && (
          <div className={`rounded p-4 mt-2 ${
            extractResult.failures.length === 0
              ? 'bg-green-50 border border-green-200'
              : 'bg-amber-50 border border-amber-200'
          }`}>
            <div className="text-sm font-semibold mb-2">
              {extractResult.failures.length === 0
                ? __('Import complete')
                : __('Import completed with issues')}
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <div>{extractResult.summary.pagesExtracted} pages</div>
              <div>{extractResult.summary.postsExtracted} posts</div>
              <div>{extractResult.summary.mediaDownloaded} images</div>
              <div>{extractResult.summary.menuItemsFound} menu items</div>
            </div>

            {extractResult.failures.length > 0 && (
              <div className="mt-3 pt-3 border-t border-amber-200 text-xs">
                <div className="font-medium mb-1">{__('Issues:')}</div>
                {extractResult.failures.slice(0, 10).map((f, i) => (
                  <div key={i} className="flex items-center gap-1 text-amber-700">
                    <span>{f.url}: {f.error}</span>
                    {isAuthenticated && (
                      <button
                        className="text-amber-600 underline ml-auto text-xs"
                        onClick={() => onAiHandoff({ failure: f, sourceUrl, sitePath })}
                      >
                        {__('Retry with AI')}
                      </button>
                    )}
                  </div>
                ))}
                {extractResult.failures.length > 10 && (
                  <div className="text-gray-500 mt-1">
                    {`... and ${extractResult.failures.length - 10} more`}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <Button variant="primary" onClick={onComplete}>
                {__('Open site')}
              </Button>
              {extractResult.failures.length === 0 ? (
                <Button onClick={() => {}}>
                  {__('Push to WordPress.com')}
                </Button>
              ) : isAuthenticated ? (
                <Button
                  onClick={() => onAiHandoff({
                    sourceUrl,
                    sitePath,
                    summary: extractResult.summary,
                    failures: extractResult.failures,
                  })}
                >
                  {__('Ask AI for help')}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </StepIndicator>

      {/* Error state */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-4 mt-4 text-sm">
          <div className="font-semibold text-red-700 mb-1">{__('Error')}</div>
          <p className="text-red-600 text-xs">{error}</p>
          <div className="flex gap-2 mt-3">
            <Button onClick={() => start(sourceUrl)}>{__('Retry')}</Button>
            {isAuthenticated && (
              <Button onClick={() => onAiHandoff({ error, sourceUrl, sitePath })}>
                {__('Ask AI for help')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Cancel button (during extraction) */}
      {stepStatuses.extracting === 'in_progress' && (
        <div className="border-t border-gray-200 pt-4 mt-4 flex justify-end">
          <Button onClick={onCancel}>{__('Cancel')}</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/components/content-tab-liberation.tsx apps/studio/src/hooks/use-liberation.ts
git commit -m "feat: add liberation progressive flow component and state hook"
```

---

### Task 6: Desktop App — AI Handoff

**Files:**
- Modify: `apps/studio/src/stores/chat-slice.ts`
- Modify: `apps/studio/src/components/content-tab-assistant.tsx`

- [ ] **Step 1: Add liberation context action to chat slice**

In `apps/studio/src/stores/chat-slice.ts`, add an action that pre-loads liberation context:

```ts
// Add to chatActions or chatSlice.reducers:
preloadLiberationContext: (state, action: PayloadAction<{
  sourceUrl: string;
  platform?: string;
  sitePath: string;
  summary?: Record<string, unknown>;
  failures?: Array<{ url: string; error: string }>;
  failure?: { url: string; error: string }; // single-item retry
  error?: string;
}>) => {
  const ctx = action.payload;
  let message: string;

  if (ctx.failure) {
    // Per-item retry context
    message = `The user is importing a site from ${ctx.sourceUrl} and needs help with a specific failure:\n` +
      `URL: ${ctx.failure.url}\nError: ${ctx.failure.error}\n` +
      `Site path: ${ctx.sitePath}\n` +
      `Try re-extracting this URL with different settings (longer timeout, different delay).`;
  } else if (ctx.error) {
    // General error context
    message = `The user is importing a site from ${ctx.sourceUrl} and hit an error:\n${ctx.error}\n` +
      `Site path: ${ctx.sitePath}`;
  } else {
    // Full summary context
    message = `The user is importing a site from ${ctx.sourceUrl} (${ctx.platform || 'unknown platform'}).\n` +
      `Extraction completed with issues:\n` +
      JSON.stringify(ctx.summary, null, 2) + '\n' +
      `Failures:\n` + JSON.stringify(ctx.failures, null, 2) + '\n' +
      `Site path: ${ctx.sitePath}\n` +
      `Extraction log: ${ctx.sitePath}/liberation/extraction-log.jsonl\n` +
      `WXR file: ${ctx.sitePath}/liberation/output.wxr`;
  }

  // Add as a system message so the agent sees the context
  state.messages.push({
    role: 'system',
    content: message,
    id: `liberation-context-${Date.now()}`,
  });
},
```

- [ ] **Step 2: Handle handoff in assistant tab**

In the component that renders the assistant, ensure system messages from liberation context are displayed as a grey info box (not as a user or assistant message):

```tsx
// In content-tab-assistant.tsx, in the message rendering:
if (message.role === 'system' && message.id?.startsWith('liberation-context')) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-600 mb-4">
      <div className="font-medium mb-1">{__('Liberation context loaded')}</div>
      <pre className="whitespace-pre-wrap">{message.content}</pre>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/stores/chat-slice.ts apps/studio/src/components/content-tab-assistant.tsx
git commit -m "feat: add AI handoff with liberation context pre-loading"
```

---

### Task 7: Desktop App — Liberation History + Sidebar Indicator

**Files:**
- Modify: `apps/studio/src/components/content-tab-import-export.tsx`
- Modify: Sidebar site list component

- [ ] **Step 1: Add Liberation History to Import/Export tab**

In `apps/studio/src/components/content-tab-import-export.tsx`, add a new section that reads `liberation/extraction-log.jsonl` from the site directory and displays a summary:

```tsx
function LiberationHistory({ sitePath }: { sitePath: string }) {
  const [history, setHistory] = useState<{
    sourceUrl?: string;
    date?: string;
    processed: number;
    failed: number;
    qualityScores: { high: number; medium: number; low: number };
  } | null>(null);

  useEffect(() => {
    const logPath = `${sitePath}/liberation/extraction-log.jsonl`;
    // Read and parse JSONL via IPC
    getIpcApi().readFile(logPath).then(content => {
      if (!content) return;
      const lines = content.split('\n').filter(Boolean);
      let processed = 0, failed = 0;
      const scores = { high: 0, medium: 0, low: 0 };
      let lastTimestamp = '';

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'processed') {
            processed++;
            if (entry.qualityScore) scores[entry.qualityScore as keyof typeof scores]++;
            lastTimestamp = entry.timestamp;
          } else if (entry.type === 'failed') {
            failed++;
          }
        } catch { /* skip incomplete lines */ }
      }

      if (processed > 0 || failed > 0) {
        setHistory({ date: lastTimestamp, processed, failed, qualityScores: scores });
      }
    }).catch(() => {});
  }, [sitePath]);

  if (!history) return null;

  return (
    <div className="mt-6">
      <h4 className="a8c-subtitle-small mb-2">{__('Liberation History')}</h4>
      <div className="bg-gray-50 rounded p-3 text-xs">
        {history.date && <div className="text-gray-500 mb-2">{__('Imported:')} {new Date(history.date).toLocaleDateString()}</div>}
        <div className="grid grid-cols-2 gap-1">
          <div>{history.processed} items imported</div>
          <div>{history.failed} items failed</div>
          <div>{history.qualityScores.high} high quality</div>
          <div>{history.qualityScores.low} low quality</div>
        </div>
      </div>
    </div>
  );
}
```

Add `<LiberationHistory sitePath={selectedSite.path} />` to the Import/Export tab component.

- [ ] **Step 2: Add sidebar liberation indicator**

In the sidebar site list component, check for an active liberation and show a spinner badge:

```tsx
// In the site list item component:
{site.isLiberating && (
  <span
    className="animate-spin text-blue-500 text-xs ml-auto"
    aria-label={`Importing content for ${site.name}`}
  >
    ↻
  </span>
)}
```

The `isLiberating` flag comes from the liberation state — the `use-liberation` hook needs to update a global store or context that the sidebar can read.

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/components/content-tab-import-export.tsx apps/studio/src/components/
git commit -m "feat: add liberation history to Import/Export tab and sidebar indicator"
```

---

### Task 8: Desktop App — Cancel Cleanup + Incomplete Detection

**Files:**
- Modify: `apps/studio/src/hooks/use-liberation.ts`
- Modify: `apps/studio/src/components/content-tab-liberation.tsx`

- [ ] **Step 1: Add cancel confirmation dialog**

When the user clicks Cancel during extraction, show a confirmation dialog:

```tsx
// In content-tab-liberation.tsx, update the cancel handler:
const { showConfirmationDialog } = useConfirmationDialog();

async function handleCancel() {
  const result = await showConfirmationDialog({
    title: __('Cancel import?'),
    message: __('Keep partial results? You can resume later with --resume.'),
    confirmLabel: __('Keep & stop'),
    cancelLabel: __('Delete & stop'),
  });

  cancel(); // Stop the MCP subprocess

  if (!result) {
    // User chose "Delete" — clean up liberation directory
    await getIpcApi().deleteDirectory(`${sitePath}/liberation`);
    onCancel();
  } else {
    // User chose "Keep" — leave partial results
    onCancel();
  }
}
```

- [ ] **Step 2: Add incomplete detection on app launch**

In a suitable initialization hook or component (e.g., the site details provider), check each site for a stale `.liberation-lock` file on startup:

```ts
// In a hook that runs on app startup / site list load:
async function checkIncompleteLiberations(sites: SiteDetails[]) {
  for (const site of sites) {
    const lockPath = `${site.path}/liberation/.liberation-lock`;
    const exists = await getIpcApi().fileExists(lockPath);
    if (!exists) continue;

    try {
      const content = await getIpcApi().readFile(lockPath);
      const lock = JSON.parse(content);

      // Check if the PID is still running (via IPC)
      const isRunning = await getIpcApi().isProcessRunning(lock.pid);
      if (isRunning) continue; // Liberation is still active

      // Stale lock — show notification
      showNotification({
        title: __('Import interrupted'),
        message: `Your import for "${site.name}" was interrupted. Resume?`,
        actions: [
          { label: __('Resume'), onClick: () => resumeLiberation(site) },
          { label: __('Dismiss'), onClick: () => getIpcApi().deleteFile(lockPath) },
        ],
      });
    } catch {
      // Corrupt lock — remove it
      await getIpcApi().deleteFile(lockPath);
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/hooks/use-liberation.ts apps/studio/src/components/content-tab-liberation.tsx
git commit -m "feat: add cancel cleanup dialog and incomplete liberation detection on launch"
```

---

### Task 9: Telemetry

**Files:**
- Modify: `apps/studio/src/hooks/use-liberation.ts`
- Modify: `apps/cli/commands/site/liberate.ts`

- [ ] **Step 1: Add stat bumps to the liberation hook (desktop app)**

In `use-liberation.ts`, call `bumpAggregatedUniqueStat` at each step transition:

```ts
import { bumpAggregatedUniqueStat } from 'cli/lib/bump-stat';

// At each step transition:
// Step started:
bumpAggregatedUniqueStat('studio_liberation', 'started', 'weekly');
// Platform detected:
bumpAggregatedUniqueStat('studio_liberation', `platform_${detection.platform}`, 'weekly');
// Extract complete:
bumpAggregatedUniqueStat('studio_liberation', extractResult.failures.length > 0 ? 'extract_partial' : 'extract_success', 'weekly');
// Import complete:
bumpAggregatedUniqueStat('studio_liberation', 'import_success', 'weekly');
// User cancelled:
bumpAggregatedUniqueStat('studio_liberation', 'cancelled', 'weekly');
// AI handoff:
bumpAggregatedUniqueStat('studio_liberation', 'ai_handoff', 'weekly');
// Resume:
bumpAggregatedUniqueStat('studio_liberation', 'resumed', 'weekly');
```

- [ ] **Step 2: Add stat bumps to CLI command**

Add similar stat bumps in `apps/cli/commands/site/liberate.ts` at the equivalent points.

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/hooks/use-liberation.ts apps/cli/commands/site/liberate.ts
git commit -m "feat: add liberation telemetry stat bumps"
```

---

### Task 10: Tests

**Files:**
- Create: `apps/studio/src/hooks/tests/use-liberation.test.ts`
- Create: `apps/cli/commands/site/tests/liberate.test.ts`

- [ ] **Step 1: Write liberation hook tests**

```ts
// apps/studio/src/hooks/tests/use-liberation.test.ts
import { describe, it, expect, vi } from 'vitest';
// Test the state machine transitions using the mock client
// Verify: idle → detecting → discovering → extracting → importing → complete
// Verify: error states at each step
// Verify: cancel stops extraction
// Verify: progress callback is throttled
```

- [ ] **Step 2: Write CLI command tests**

```ts
// apps/cli/commands/site/tests/liberate.test.ts
import { describe, it, expect, vi } from 'vitest';
// Test with mock LiberationClient
// Verify: happy path output matches expected terminal output
// Verify: error output includes failure details
// Verify: --dry-run stops after preview
// Verify: --output-only skips site creation
// Verify: LIBERATION_TOKEN env var is read
// Verify: --resume is passed through
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/hooks/tests/ apps/cli/commands/site/tests/
git commit -m "test: add liberation hook and CLI command tests"
```
