#!/usr/bin/env node
/**
 * MCP Server for data-liberation-agent
 *
 * Wraps the existing extraction and import scripts as MCP tools
 * so Claude can drive migrations conversationally.
 *
 * Installation (Claude Desktop claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "data-liberation": {
 *         "command": "node",
 *         "args": ["/path/to/data-liberation-agent/mcp-server.js"]
 *       }
 *     }
 *   }
 *
 * Installation (Claude Code):
 *   claude mcp add data-liberation -- node /path/to/data-liberation-agent/mcp-server.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Run a script and capture its output
function runScript(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(__dirname, script), ...args], {
      cwd: __dirname,
      timeout: 300_000, // 5 min max
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }));
  });
}

// Read a JSON file from the output directory
function readOutput(filename) {
  const path = join(__dirname, 'output', filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const server = new McpServer({
  name: 'data-liberation',
  version: '0.1.0',
});

// ── Tools ───────────────────────────────────────────────────

server.tool(
  'discover_site',
  'Inventory a Wix site: fetches sitemap, categorizes all URLs (pages, blog posts, products, etc.), and extracts navigation structure. Run this first before extraction.',
  {
    url: z.string().describe('The Wix site URL (e.g. https://yoursite.wixsite.com/sitename)'),
    cdp_port: z.number().optional().describe('CDP port if connecting to a running browser (e.g. 9222)'),
    user_agent: z.string().optional().describe('Custom user agent string'),
  },
  async ({ url, cdp_port, user_agent }) => {
    const args = [url];
    if (cdp_port) args.push('--cdp-port', String(cdp_port));
    if (user_agent) args.push('--user-agent', user_agent);

    const result = await runScript('scripts/wix/discover.js', args);
    const inventory = readOutput('inventory.json');

    if (result.code !== 0) {
      return {
        content: [{ type: 'text', text: `Discovery failed:\n${result.stderr}\n${result.stdout}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: {
            siteUrl: inventory?.siteUrl,
            totalUrls: inventory?.urls?.length || 0,
            counts: inventory?.counts || {},
            navigationItems: inventory?.navigation?.length || 0,
          },
          urls: inventory?.urls || [],
          navigation: inventory?.navigation || [],
          scriptOutput: result.stdout,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'extract_site',
  'Extract all content from a Wix site by intercepting internal API calls during page load. Returns structured JSON with page content, metadata, and media URLs. Run discover_site first.',
  {
    url: z.string().describe('The Wix site URL'),
    cdp_port: z.number().optional().describe('CDP port if connecting to a running browser'),
    user_agent: z.string().optional().describe('Custom user agent string'),
    delay: z.number().optional().describe('Delay between pages in ms (default 500, increase for large sites)'),
    limit: z.number().optional().describe('Only process first N URLs (for testing)'),
  },
  async ({ url, cdp_port, user_agent, delay, limit }) => {
    const args = [url];
    if (cdp_port) args.push('--cdp-port', String(cdp_port));
    if (user_agent) args.push('--user-agent', user_agent);
    if (delay) args.push('--delay', String(delay));
    if (limit) args.push('--limit', String(limit));

    // Use inventory if available
    if (existsSync(join(__dirname, 'output/inventory.json'))) {
      args.push('--url-list', 'output/inventory.json');
    }

    const result = await runScript('scripts/wix/extract.js', args);
    const log = readOutput('extraction-log.json');

    if (result.code !== 0 && !log) {
      return {
        content: [{ type: 'text', text: `Extraction failed:\n${result.stderr}\n${result.stdout}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          pagesExtracted: log?.processed?.length || 0,
          mediaDownloaded: log?.mediaDownloaded?.length || 0,
          failures: log?.failed?.length || 0,
          processed: log?.processed || [],
          failed: log?.failed || [],
          scriptOutput: result.stdout,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'extract_page',
  'Extract a single page from a Wix site. Useful for incremental extraction or re-extracting a failed page.',
  {
    url: z.string().describe('The Wix site URL'),
    cdp_port: z.number().optional().describe('CDP port if connecting to a running browser'),
    user_agent: z.string().optional().describe('Custom user agent string'),
  },
  async ({ url, cdp_port, user_agent }) => {
    const args = [url, '--limit', '1'];
    if (cdp_port) args.push('--cdp-port', String(cdp_port));
    if (user_agent) args.push('--user-agent', user_agent);

    const result = await runScript('scripts/wix/extract.js', args);
    const log = readOutput('extraction-log.json');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.code === 0,
          processed: log?.processed || [],
          failed: log?.failed || [],
          scriptOutput: result.stdout,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'probe_site',
  'Connect to a running browser via CDP and extract Wix internals: window globals, cookies, localStorage, API endpoints from performance entries, and site identity. Requires the user to have their browser open with CDP enabled.',
  {
    cdp_port: z.number().default(9222).describe('CDP port of the running browser'),
  },
  async ({ cdp_port }) => {
    const result = await runScript('scripts/wix/probe.js', ['--port', String(cdp_port)]);
    const probeData = readOutput('probe/wix-probe.json');

    if (result.code !== 0) {
      return {
        content: [{ type: 'text', text: `Probe failed:\n${result.stderr}\n${result.stdout}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          pagesProbed: probeData?.length || 0,
          results: probeData || [],
          scriptOutput: result.stdout,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'map_apis',
  'Comprehensive Wix API mapper. Navigates through the Wix dashboard, blog, store, editor, etc. and logs ALL API requests and responses. Produces a full endpoint catalog. Requires CDP connection to a browser logged into Wix.',
  {
    cdp_port: z.number().default(9223).describe('CDP port of the running browser'),
  },
  async ({ cdp_port }) => {
    const result = await runScript('scripts/wix/map-apis.js', ['--cdp-port', String(cdp_port)]);
    const endpoints = readOutput('api-map/endpoints.json');

    if (result.code !== 0 && !endpoints) {
      return {
        content: [{ type: 'text', text: `API mapping failed:\n${result.stderr}\n${result.stdout}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalEndpoints: endpoints?.length || 0,
          endpoints: endpoints || [],
          scriptOutput: result.stdout,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'import_to_wordpress',
  'Import extracted content to WordPress.com via REST API. Uploads media first, then creates pages and posts as drafts. Run extract_site first.',
  {
    site: z.string().describe('WordPress.com site domain (e.g. mysite.wordpress.com)'),
    token: z.string().describe('WordPress.com application password'),
    dry_run: z.boolean().default(false).describe('Preview what would be imported without making changes'),
    only: z.enum(['media', 'pages', 'posts']).optional().describe('Only import a specific content type'),
  },
  async ({ site, token, dry_run, only }) => {
    const args = ['--site', site, '--token', token];
    if (dry_run) args.push('--dry-run');
    if (only) args.push('--only', only);

    const result = await runScript('scripts/import.js', args);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.code === 0,
          dryRun: dry_run,
          output: result.stdout,
          errors: result.stderr || undefined,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'get_inventory',
  'Read the current site inventory from a previous discover_site run. Returns the categorized URL list without re-scanning.',
  {},
  async () => {
    const inventory = readOutput('inventory.json');
    if (!inventory) {
      return {
        content: [{ type: 'text', text: 'No inventory found. Run discover_site first.' }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(inventory, null, 2) }],
    };
  }
);

server.tool(
  'get_extraction_log',
  'Read the extraction log from a previous extract_site run. Shows which pages were processed, which failed, and what media was downloaded.',
  {},
  async () => {
    const log = readOutput('extraction-log.json');
    if (!log) {
      return {
        content: [{ type: 'text', text: 'No extraction log found. Run extract_site first.' }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(log, null, 2) }],
    };
  }
);

// ── Prompts ─────────────────────────────────────────────────

server.prompt(
  'migrate-from-wix',
  'Step-by-step guide for migrating a Wix site to WordPress.com',
  { url: z.string().optional().describe('The Wix site URL to migrate') },
  ({ url }) => {
    const promptText = readFileSync(join(__dirname, 'prompts/wix.md'), 'utf8');
    const customized = url
      ? promptText.replace('[PASTE YOUR WIX URL HERE]', url)
      : promptText;

    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: customized },
      }],
    };
  }
);

// ── Start ───────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
