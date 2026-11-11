import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectSource } from './lib/inspect.js';

const SERVER = fileURLToPath(new URL('./mcp-server.ts', import.meta.url));
let fixture: Server | undefined;
let platformDir: string | undefined;

async function startFixture(): Promise<string> {
  fixture = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === '/sitemap.xml') {
      const port = (fixture!.address() as { port: number }).port;
      response.end(`<urlset><url><loc>http://localtest.me:${port}/post/one</loc></url></urlset>`);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<title>fixture</title><form></form>');
  });
  await new Promise<void>((resolve) => fixture!.listen(0, '127.0.0.1', resolve));
  return `http://localtest.me:${(fixture.address() as { port: number }).port}/`;
}

afterEach(async () => {
  if (fixture) await new Promise<void>((resolve, reject) => fixture!.close((error) => error ? reject(error) : resolve()));
  fixture = undefined;
  if (platformDir) await rm(platformDir, { recursive: true, force: true });
  platformDir = undefined;
});

function inspectViaMcp(url: string, env = process.env): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP inspect did not answer'));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split('\n')) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text: string }> } };
          if (message.id === 3 && message.result?.content?.[0]) {
            clearTimeout(timer);
            child.kill();
            resolve(JSON.parse(message.result.content[0].text));
          }
        } catch { /* partial line */ }
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect', arguments: { url, discoveryLimit: 2, sampleLimit: 1 } } })}\n`);
  });
}

describe('MCP inspect', () => {
  it('loads env-named external platforms before CLI and MCP detection', async () => {
    const url = await startFixture();
    await mkdir('.tmp-test', { recursive: true });
    platformDir = await mkdtemp(resolvePath('.tmp-test/external-platform-'));
    const modulePath = resolvePath(platformDir, 'platform.mjs');
    await writeFile(modulePath, `export default async ({ registerPlatform }) => {
      await Promise.resolve();
      registerPlatform({
        id: 'startup-fixture',
        detection: { sourceSignals: [{ pattern: /<title>fixture<\\/title>/, signal: 'fixture title' }] },
        discover: async (url) => ({ urls: [{ url, type: 'homepage' }] }),
      });
    };`);
    const env = { ...process.env, DATA_LIBERATION_PLATFORMS: modulePath };
    const cli = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), 'inspect', url, '--http-only'], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(cli.stderr).not.toContain('External platform');
    expect(cli.code).toBe(0);
    expect(JSON.parse(cli.stdout).source.platform.id).toBe('startup-fixture');
    expect(await inspectViaMcp(url, env)).toMatchObject({ source: { platform: { id: 'startup-fixture' } } });
  }, 45_000);

  it('returns the public inspection result through the inspect tool', async () => {
    const url = await startFixture();
    const expected = await inspectSource(url, { discoveryLimit: 2, sampleLimit: 1 });
    const result = await inspectViaMcp(url);
    expect(result).toMatchObject({
      schemaVersion: expected.schemaVersion,
      source: expected.source,
      coverage: expected.coverage,
      routes: expected.routes,
      samples: expected.samples,
      unknowns: expected.unknowns,
      issues: expected.issues,
    });
  }, 45_000);
});
