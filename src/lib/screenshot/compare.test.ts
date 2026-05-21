import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { compareScreenshotDirs } from './compare.js';

const TMP = join(process.cwd(), '.tmp-test', 'compare');

/** Write a solid RGBA PNG of w×h at `path`. */
function writeSolidPng(path: string, w: number, h: number, rgba: [number, number, number, number]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    png.data[o] = rgba[0]; png.data[o + 1] = rgba[1]; png.data[o + 2] = rgba[2]; png.data[o + 3] = rgba[3];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

/** Build a screenshot dir: manifest.json + <viewport>/<slug>.png for one page. */
function buildDir(dir: string, url: string, slug: string, png: { w: number; h: number; color: [number, number, number, number] }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, entries: { [url]: { slug, capturedAt: '2026-05-20T00:00:00Z' } } }, null, 2));
  for (const vp of ['desktop', 'mobile']) writeSolidPng(join(dir, vp, `${slug}.png`), png.w, png.h, png.color);
}

describe('compareScreenshotDirs', () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('scores identical screenshots as 1.0', async () => {
    const origin = join(TMP, 'origin');
    const replica = join(TMP, 'replica');
    buildDir(origin, 'https://origin.test/services', 'services', { w: 1440, h: 900, color: [10, 20, 30, 255] });
    buildDir(replica, 'http://localhost:8881/services', 'services', { w: 1440, h: 900, color: [10, 20, 30, 255] });

    const result = await compareScreenshotDirs({ originDir: origin, replicaDir: replica });

    expect(result.results).toHaveLength(1);
    const r = result.results[0];
    expect(r.pathname).toBe('/services');
    expect(r.desktop.status).toBe('ok');
    expect(r.desktop.score).toBe(1);
    expect(r.mobile.score).toBe(1);
  });

  it('scores fully-different screenshots near 0', async () => {
    const origin = join(TMP, 'origin');
    const replica = join(TMP, 'replica');
    buildDir(origin, 'https://origin.test/x', 'x', { w: 1440, h: 900, color: [0, 0, 0, 255] });
    buildDir(replica, 'http://localhost:8881/x', 'x', { w: 1440, h: 900, color: [255, 255, 255, 255] });

    const result = await compareScreenshotDirs({ originDir: origin, replicaDir: replica });
    expect(result.results[0].desktop.score).toBeLessThan(0.01);
  });
});
