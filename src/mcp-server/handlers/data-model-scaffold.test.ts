import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext, ToolResult } from '../handler-types.js';
import { dataModelScaffoldHandler } from './data-model-scaffold.js';

const ctx = {
  textResult: (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  errorResult: (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true }),
} as unknown as HandlerContext;
const TMP = join(process.cwd(), '.tmp-test');

describe('dataModelScaffoldHandler', () => {
  it('scaffolds with NO assets/ dir and a malformed JS file present (skips, never aborts)', async () => {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, 'dms-'));
    const out = mkdtempSync(join(TMP, 'dms-out-'));
    try {
      writeFileSync(join(dir, 'shop.html'), `<div class="g" id="grid"></div>`);
      writeFileSync(join(dir, 'data.js'), `const ITEMS=[{id:'a',title:'A',cat:'x'},{id:'b',title:'B',cat:'y'}]; mount('#grid', ITEMS); function open(i){return ITEMS.find(x=>x.id===i);}`);
      writeFileSync(join(dir, 'broken.js'), `const x = {{{ not valid`);
      const res = await dataModelScaffoldHandler({ dir, outputDir: out }, ctx);
      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text) as { model: { items: unknown[] }; discovered: { skippedFiles: string[] } };
      expect(data.model.items).toHaveLength(2);
      expect(data.discovered.skippedFiles).toContain('broken.js');
      expect(existsSync(join(out, 'data-model.draft.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('scaffolds inline script data arrays and mount calls from HTML files', async () => {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, 'dms-inline-'));
    const out = mkdtempSync(join(TMP, 'dms-inline-out-'));
    try {
      writeFileSync(
        join(dir, 'shop.html'),
        `<div id="grid"></div><script>const ITEMS=[{id:'a',title:'A',cat:'x'},{id:'b',title:'B',cat:'y'}]; mountGrid('#grid', ITEMS); function open(i){return ITEMS.find(x=>x.id===i);}</script>`
      );
      const res = await dataModelScaffoldHandler({ dir, outputDir: out }, ctx);
      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text) as { model: { items: unknown[]; mounts: Array<{ selector: string }> } };
      expect(data.model.items).toHaveLength(2);
      expect(data.model.mounts.map((mount) => mount.selector)).toContain('#grid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
