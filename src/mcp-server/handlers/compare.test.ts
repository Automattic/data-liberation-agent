import { describe, it, expect } from 'vitest';
import { compareHandler } from './compare.js';
import type { HandlerContext, ToolResult } from '../handler-types.js';

function fakeCtx(): HandlerContext {
  return {
    adapters: [],
    findAdapter: () => null,
    textResult: (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    errorResult: (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true }),
    server: {} as never,
  };
}

describe('compareHandler', () => {
  it('errors when originDir/replicaDir are missing', async () => {
    const res = await compareHandler({}, fakeCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/originDir.*replicaDir/);
  });
});
