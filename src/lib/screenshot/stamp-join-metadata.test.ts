import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WxrBuilder } from '../extraction/wxr-builder.js';
import { stampJoinMetadata } from './stamp-join-metadata.js';

function setupFixture(): { outputDir: string; wxrPath: string; productsJsonlPath: string; manifestPath: string } {
  const outputDir = mkdtempSync(join(tmpdir(), 'stamp-'));

  const b = new WxrBuilder({ title: 'x', url: 'https://origin.example.com', description: '', language: 'en-US' });
  b.addPage({ title: 'About', slug: 'about', sourceUrl: 'https://origin.example.com/about/' });
  b.addPost({ title: 'Hello', slug: 'hello', sourceUrl: 'https://origin.example.com/blog/hello/' });
  const wxrPath = join(outputDir, 'output.wxr');
  b.serialize(wxrPath);

  const productsJsonlPath = join(outputDir, 'products.jsonl');
  writeFileSync(productsJsonlPath, [
    JSON.stringify({ name: 'Widget', sourceUrl: 'https://origin.example.com/p/widget' }),
    JSON.stringify({ name: 'Gizmo', sourceUrl: 'https://origin.example.com/p/gizmo' }),
  ].join('\n') + '\n');

  mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
  const manifestPath = join(outputDir, 'screenshots', 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    entries: {
      'https://origin.example.com/about/': {
        slug: 'about',
        desktop: 'screenshots/desktop/about.png',
        mobile: 'screenshots/mobile/about.png',
        html: 'html/about.html',
        capturedAt: '2025-01-01',
      },
      'https://origin.example.com/p/widget': {
        slug: 'p--widget',
        desktop: 'screenshots/desktop/p--widget.png',
        mobile: 'screenshots/mobile/p--widget.png',
        html: 'html/p--widget.html',
        capturedAt: '2025-01-01',
      },
    },
  }, null, 2));

  return { outputDir, wxrPath, productsJsonlPath, manifestPath };
}

describe('stampJoinMetadata', () => {
  it('adds _liberation_* postmeta to matching pages/posts', async () => {
    const fx = setupFixture();
    try {
      await stampJoinMetadata({ outputDir: fx.outputDir });
      const xml = readFileSync(fx.wxrPath, 'utf8');
      expect(xml).toContain('_liberation_screenshot_desktop');
      expect(xml).toContain('screenshots/desktop/about.png');
      expect(xml).toContain('_liberation_html');
    } finally {
      rmSync(fx.outputDir, { recursive: true, force: true });
    }
  });

  it('adds meta:_liberation_* to products.jsonl entries', async () => {
    const fx = setupFixture();
    try {
      await stampJoinMetadata({ outputDir: fx.outputDir });
      const lines = readFileSync(fx.productsJsonlPath, 'utf8').trim().split('\n');
      const widget = JSON.parse(lines[0]);
      expect(widget.meta?._liberation_screenshot_desktop).toBe('screenshots/desktop/p--widget.png');
    } finally {
      rmSync(fx.outputDir, { recursive: true, force: true });
    }
  });

  it('is idempotent — running twice does not duplicate postmeta', async () => {
    const fx = setupFixture();
    try {
      await stampJoinMetadata({ outputDir: fx.outputDir });
      const xml1 = readFileSync(fx.wxrPath, 'utf8');
      await stampJoinMetadata({ outputDir: fx.outputDir });
      const xml2 = readFileSync(fx.wxrPath, 'utf8');
      const count1 = (xml1.match(/_liberation_screenshot_desktop/g) ?? []).length;
      const count2 = (xml2.match(/_liberation_screenshot_desktop/g) ?? []).length;
      expect(count2).toBe(count1);
    } finally {
      rmSync(fx.outputDir, { recursive: true, force: true });
    }
  });

  it('silently no-ops for products lacking sourceUrl (legacy resume)', async () => {
    const fx = setupFixture();
    try {
      writeFileSync(fx.productsJsonlPath, [
        JSON.stringify({ name: 'Legacy' }),
        JSON.stringify({ name: 'Widget', sourceUrl: 'https://origin.example.com/p/widget' }),
      ].join('\n') + '\n');
      await stampJoinMetadata({ outputDir: fx.outputDir });
      const lines = readFileSync(fx.productsJsonlPath, 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0]).meta?._liberation_screenshot_desktop).toBeUndefined();
      expect(JSON.parse(lines[1]).meta?._liberation_screenshot_desktop).toBeDefined();
    } finally {
      rmSync(fx.outputDir, { recursive: true, force: true });
    }
  });

  it('writes atomically (no .tmp file left after success)', async () => {
    const fx = setupFixture();
    try {
      await stampJoinMetadata({ outputDir: fx.outputDir });
      expect(existsSync(fx.wxrPath + '.tmp')).toBe(false);
      expect(existsSync(fx.productsJsonlPath + '.tmp')).toBe(false);
    } finally {
      rmSync(fx.outputDir, { recursive: true, force: true });
    }
  });
});
