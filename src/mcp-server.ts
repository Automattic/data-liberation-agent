// src/mcp-server.ts
//
// MCP as a transport, not an architecture.
//
// The product is four verbs, so this exposes four tools that call the same
// entry points the CLI calls. It deliberately does not expose pipeline phases:
// a caller that has to drive discovery, capture, and export in sequence is
// reimplementing the CLI, and the surface then has to be maintained against
// every internal change.
//
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpInputSchema, convertMcpOptions, version, type Verb } from './options.js';
import { loadExternalPlatforms } from './platform/load-external.js';

/**
 * MCP tool result envelope. The index signature is what keeps it assignable to
 * the SDK's ServerResult union, which is declared with `[key: string]: unknown`.
 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

const textResult = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  isError: true,
});

const descriptions: Record<Verb, string> = {
  inspect: 'Bounded, read-only source assessment. Returns measured observations, coverage, unknowns and issues without writing a site.',
  liberate: 'Liberate a website into a portable HTML site. Browser capture is the default; HTTP creates an unverified review candidate.',
  compare: 'Verify frozen source/capture evidence or portable capture/candidate fidelity. Only explicit drift revisits the live source.',
  publish: 'Publish a liberated site to a live URL. Returns the live URL and any claim link.',
};
const TOOLS = (Object.keys(descriptions) as Verb[]).map(name => ({ name, description: descriptions[name], inputSchema: mcpInputSchema(name) }));

const server = new Server(
  { name: 'data-liberation', version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const log = (message: string) => {
    void server.sendLoggingMessage({ level: 'info', data: message }).catch(() => undefined);
  };

  try {
    if (!(name in descriptions)) return errorResult(`Unknown tool: ${name}`);
    const options = convertMcpOptions(name as Verb, args);
    if (name === 'inspect') {
      const { inspectSource } = await import('./lib/inspect.js');
      return textResult(await inspectSource(String(args.url ?? ''), {
        ...options,
        log,
      }));
    }

    if (name === 'liberate') {
      const { liberateSite } = await import('./ui/liberate.js');
      const result = await liberateSite({
        ...options as Omit<Parameters<typeof liberateSite>[0], 'url'>,
        url: String(args.url),
        log,
      });
      return textResult({
        websiteDir: result.websiteDir,
        routesDiscovered: result.routesDiscovered,
        routesCaptured: result.routesCaptured,
        routesSkipped: result.routesSkipped,
        routesFailed: result.routesFailed,
        routesOmitted: result.routesOmitted,
        complete: result.complete,
        entrypointCaptured: result.entrypointCaptured,
        missingRoutes: result.missingRoutes,
        usable: result.usable,
        unresolvedAnchors: result.unresolvedAnchors,
      });
    }

    if (name === 'compare') {
      const { runCompare } = await import('./ui/compare.js');
      const report = await runCompare(String(args.directory), { ...options, log, write: log });
      return textResult(report);
    }

    if (name === 'publish') {
      const { publishSite } = await import('./ui/publish.js');
      const result = await publishSite({
        directory: String(args.directory ?? ''),
        ...options as { target: string; token?: string; space?: string },
        log,
      });
      return textResult(result);
    }

    return errorResult(`Unknown tool: ${name}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

async function main() {
  const { failed } = await loadExternalPlatforms();
  for (const { entry, error } of failed) console.error(`External platform ${entry}: ${error}`);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
