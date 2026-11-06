import { expect, it, vi } from 'vitest';
import { SourceBlockedClientError } from './lib/source-request-governor.js';

vi.mock('./ui/liberate.js', () => ({
  liberateSite: async () => { throw new SourceBlockedClientError({ origin: 'https://source.test', requestsBeforeFirstRefusal: 12, firstRefusalAt: '2026-01-01T00:00:00Z' }); },
}));

it('prints blocked-source evidence as one clean CLI error instead of uncaught bundle source', async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    process.argv = ['node', 'cli', 'https://source.test'];
    await import('./cli.js');
    expect(process.exitCode).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    const output = String(write.mock.calls[0][0]);
    expect(output.split('\n')).toHaveLength(2);
    expect(JSON.parse(output)).toMatchObject({ code: 'source_blocked_client', evidence: { requestsBeforeFirstRefusal: 12 } });
    expect(output).not.toMatch(/bundle\.mjs|\bat .*:\d+:\d+|throw new/);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    write.mockRestore();
  }
});
