import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
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

  it('scaffolds posts from a static-HTML card grid, extracting bodies from linked pages', async () => {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, 'dms-cards-'));
    const out = mkdtempSync(join(TMP, 'dms-cards-out-'));
    try {
      writeFileSync(join(dir, 'index.html'), `
      <main><div class="cluster">
        <article class="tile"><div class="thumb"><img src="a.png"></div><div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="p1.html">Alpha</a></h3><p>Excerpt alpha here long enough.</p><time>Jan 1, 2024</time></div></article>
        <article class="tile"><div class="thumb"><img src="b.png"></div><div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="p2.html">Beta</a></h3><p>Excerpt beta here long enough.</p><time>Jan 2, 2024</time></div></article>
        <article class="tile"><div class="thumb"><img src="c.png"></div><div class="meat">
          <a class="kicker" href="cat-reviews.html">Reviews</a>
          <h3><a href="p3.html">Gamma</a></h3><p>Excerpt gamma here long enough.</p><time>Jan 3, 2024</time></div></article>
      </div></main>`);
      writeFileSync(join(dir, 'p1.html'), `<main><article><p>The full body of Alpha, longer than its excerpt.</p></article></main>`);
      const res = await dataModelScaffoldHandler({ dir, outputDir: out }, ctx);
      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text) as {
        model: { items: Array<{ title: string; content?: string }> };
        discovered: { source: string };
      };
      expect(data.discovered.source).toBe('html-cards');
      expect(data.model.items).toHaveLength(3);
      const alpha = data.model.items.find((i) => i.title === 'Alpha')!;
      expect(alpha.content).toContain('The full body of Alpha');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('does not resolve card links outside the source directory', async () => {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, 'dms-cards-'));
    const sibling = `${dir}-sibling`;
    const out = mkdtempSync(join(TMP, 'dms-cards-out-'));
    try {
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(dir, 'index.html'), `
      <main><div class="cluster">
        <article class="tile"><div class="thumb"><img src="a.png"></div><div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="../${basename(sibling)}/p1.html">Alpha</a></h3><p>Excerpt alpha here long enough.</p><time>Jan 1, 2024</time></div></article>
        <article class="tile"><div class="thumb"><img src="b.png"></div><div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="p2.html">Beta</a></h3><p>Excerpt beta here long enough.</p><time>Jan 2, 2024</time></div></article>
        <article class="tile"><div class="thumb"><img src="c.png"></div><div class="meat">
          <a class="kicker" href="cat-reviews.html">Reviews</a>
          <h3><a href="p3.html">Gamma</a></h3><p>Excerpt gamma here long enough.</p><time>Jan 3, 2024</time></div></article>
      </div></main>`);
      writeFileSync(join(sibling, 'p1.html'), `<main><article><p>Escaped Alpha body should not be read.</p></article></main>`);
      const res = await dataModelScaffoldHandler({ dir, outputDir: out }, ctx);
      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text) as {
        model: { items: Array<{ title: string; content?: string }> };
        discovered: { source: string };
      };
      expect(data.discovered.source).toBe('html-cards');
      const alpha = data.model.items.find((i) => i.title === 'Alpha')!;
      expect(alpha.content).toContain('Excerpt alpha here long enough.');
      expect(alpha.content).not.toContain('Escaped Alpha body');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('resolves card links when the source dir is the current directory', async () => {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, 'dms-cards-cwd-'));
    const out = mkdtempSync(join(TMP, 'dms-cards-cwd-out-'));
    const cwd = process.cwd();
    try {
      writeFileSync(join(dir, 'index.html'), `
      <main><div class="cluster">
        <article class="tile"><div class="thumb"><img src="a.png"></div><div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="p1.html">Alpha</a></h3><p>Excerpt alpha here long enough.</p><time>Jan 1, 2024</time></div></article>
        <article class="tile"><div class="thumb"><img src="b.png"></div><div class="meat">
          <a class="kicker" href="cat-news.html">News</a>
          <h3><a href="p2.html">Beta</a></h3><p>Excerpt beta here long enough.</p><time>Jan 2, 2024</time></div></article>
        <article class="tile"><div class="thumb"><img src="c.png"></div><div class="meat">
          <a class="kicker" href="cat-reviews.html">Reviews</a>
          <h3><a href="p3.html">Gamma</a></h3><p>Excerpt gamma here long enough.</p><time>Jan 3, 2024</time></div></article>
      </div></main>`);
      writeFileSync(join(dir, 'p1.html'), `<main><article><p>The cwd Alpha body, longer than its excerpt.</p></article></main>`);
      process.chdir(dir);
      const res = await dataModelScaffoldHandler({ dir: '.', outputDir: out }, ctx);
      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text) as {
        model: { items: Array<{ title: string; content?: string }> };
        discovered: { source: string };
      };
      expect(data.discovered.source).toBe('html-cards');
      const alpha = data.model.items.find((i) => i.title === 'Alpha')!;
      expect(alpha.content).toContain('The cwd Alpha body');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
