import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('cli', () => {
  it('prints usage for --help regardless of a preceding unrecognized token, instead of crashing on a fetch', async () => {
    const result = await runCli(['capture', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).not.toContain('SsrfBlockedError');
  }, 30_000);

  it('rejects a first argument that is neither a known subcommand nor a parseable URL, naming the valid subcommands', async () => {
    const result = await runCli(['capture']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('inspect');
    expect(result.stderr).toContain('compare');
    expect(result.stderr).toContain('publish');
    expect(result.stderr).toContain('mcp');
    expect(result.stderr).not.toContain('SsrfBlockedError');
  }, 30_000);

  it('documents the shared route budget and rejects an invalid one before any request', async () => {
    expect((await runCli(['--help'])).stdout).toContain('--route-limit <n|all>');
    const result = await runCli(['https://example.invalid/', '--route-limit', '0']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--route-limit requires a positive integer or "all"');
  }, 30_000);

  it('documents the time budget and per-file limit and rejects invalid values before any request', async () => {
    const help = (await runCli(['--help'])).stdout;
    expect(help).toContain('--time-budget <duration>');
    expect(help).toContain('--max-file-bytes <n>');
    const budget = await runCli(['https://example.invalid/', '--time-budget', 'soon']);
    expect(budget.code).not.toBe(0);
    expect(budget.stderr).toContain('--time-budget requires a positive duration');
    const limit = await runCli(['https://example.invalid/', '--max-file-bytes', '0']);
    expect(limit.code).not.toBe(0);
    expect(limit.stderr).toContain('--max-file-bytes requires a positive integer');
  }, 30_000);

  it('documents and validates a per-route deadline before any request', async () => {
    expect((await runCli(['--help'])).stdout).toContain('--route-deadline <duration>');
    const result = await runCli(['https://example.invalid/', '--route-deadline', 'soon']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--route-deadline requires a positive duration');
  }, 30_000);

  it('documents the total export budget and rejects invalid values before any request', async () => {
    const help = (await runCli(['--help'])).stdout;
    expect(help).toContain('--max-total-bytes <n>');
    expect(help).toContain('--max-files <n>');
    const bytes = await runCli(['https://example.invalid/', '--max-total-bytes', '-1']);
    expect(bytes.code).not.toBe(0);
    expect(bytes.stderr).toContain('--max-total-bytes requires a positive integer');
    const files = await runCli(['https://example.invalid/', '--max-files', 'many']);
    expect(files.code).not.toBe(0);
    expect(files.stderr).toContain('--max-files requires a positive integer');
  }, 30_000);

  it('documents the device mode and rejects an unknown one before any request', async () => {
    expect((await runCli(['--help'])).stdout).toContain('--device-mode <mode>');
    const result = await runCli(['https://example.invalid/', '--device-mode', 'phone']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--device-mode requires auto, dual or reflow-only');
  }, 30_000);

  it('reproduces the reported repro verbatim: "capture" alone fails with guidance, not an SSRF stack trace', async () => {
    const result = await runCli(['capture']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"capture"');
    expect(result.stderr).not.toContain('unparseable URL');
  }, 30_000);
});
