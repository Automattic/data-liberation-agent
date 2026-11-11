import { beforeEach, expect, it, vi } from 'vitest';
import { version } from './options.js';

const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  handlers: [] as Array<(request: any) => Promise<any>>,
  compare: vi.fn(async () => ({ pass: true })),
  liberate: vi.fn(async () => ({ complete: true })),
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    constructor(...args: unknown[]) { mocks.server(...args); }
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { mocks.handlers.push(handler); }
    async connect() {}
    async close() {}
    async sendLoggingMessage() {}
  },
}));
vi.mock('./ui/compare.js', () => ({ runCompare: mocks.compare }));
vi.mock('./ui/liberate.js', () => ({ liberateSite: mocks.liberate }));

beforeEach(() => { vi.clearAllMocks(); });

it('advertises package version and the generated full option surface, and dispatches shared entry points', async () => {
  const sigint = process.listeners('SIGINT');
  const sigterm = process.listeners('SIGTERM');
  try {
    await import('./mcp-server.js');
    expect(mocks.server).toHaveBeenCalledWith({ name: 'data-liberation', version }, expect.anything());
    const listed = await mocks.handlers[0]({});
    const schema = listed.tools.find((tool: { name: string }) => tool.name === 'liberate').inputSchema;
    expect(schema.properties).toMatchObject({
      learnFluid: { type: 'boolean' },
      referenceSample: { anyOf: expect.any(Array) },
      routeDeadlineMs: { type: 'integer' },
      deviceMode: { enum: ['auto', 'dual', 'reflow-only'] },
    });
    expect(schema.properties).not.toHaveProperty('serve');
    const call = (name: string, args: Record<string, unknown>) => mocks.handlers[1]({ params: { name, arguments: args } });
    await call('liberate', { url: 'https://example.com', learnFluid: false, referenceSample: 'all', routeDeadlineMs: 30000, deviceMode: 'dual' });
    expect(mocks.liberate).toHaveBeenCalledWith(expect.objectContaining({ learnFluid: false, referenceSample: 'all', routeDeadlineMs: 30000, deviceMode: 'dual', serve: false }));
    await call('compare', { directory: './run', stage: 'materialization' });
    expect(mocks.compare).toHaveBeenCalledWith('./run', expect.objectContaining({ stage: 'materialization', write: expect.any(Function), log: expect.any(Function) }));
    expect(await call('inspect', { url: 'https://example.com', sampleLimit: NaN })).toMatchObject({ isError: true });
  } finally {
    for (const listener of process.listeners('SIGINT')) if (!sigint.includes(listener)) process.removeListener('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!sigterm.includes(listener)) process.removeListener('SIGTERM', listener);
  }
});
