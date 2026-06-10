// src/lib/replicate/parity/diff-regions.test.ts
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { extractDiffRegions } from './diff-regions.js';

/** Build a diff PNG buffer: white base, red rows at given y (full width). */
function diffPng(width: number, height: number, redRows: Array<{ y: number; x0: number; x1: number }>): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255); // white, alpha 255
  for (const r of redRows) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = (r.y * width + x) * 4;
      png.data[i] = 255;
      png.data[i + 1] = 0;
      png.data[i + 2] = 0;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('extractDiffRegions', () => {
  it('clusters mismatch rows into y-band regions with x extents', () => {
    const buf = diffPng(100, 200, [
      { y: 10, x0: 20, x1: 60 },
      { y: 12, x0: 25, x1: 70 },   // same band (gap < 8)
      { y: 100, x0: 0, x1: 99 },   // second band
    ]);
    const regions = extractDiffRegions(buf, { scale: 1 });
    expect(regions).toEqual([
      { top: 10, bottom: 12, left: 20, right: 70, pixels: 87 },
      { top: 100, bottom: 100, left: 0, right: 99, pixels: 100 },
    ]);
  });

  it('merges bands within the gap tolerance and scales to logical px', () => {
    const buf = diffPng(140, 100, [
      { y: 14, x0: 14, x1: 28 },
      { y: 20, x0: 14, x1: 28 },   // gap 6 <= 8 -> same band
    ]);
    const regions = extractDiffRegions(buf, { scale: 0.7 }); // desktop capture scale
    expect(regions).toHaveLength(1);
    expect(regions[0].top).toBe(20);     // 14 / 0.7
    expect(regions[0].bottom).toBe(29);  // round(20 / 0.7)
    expect(regions[0].left).toBe(20);
    expect(regions[0].right).toBe(40);
  });

  it('ignores tiny noise below minPixels', () => {
    const buf = diffPng(100, 100, [{ y: 5, x0: 50, x1: 51 }]);
    expect(extractDiffRegions(buf, { scale: 1, minPixels: 10 })).toEqual([]);
  });

  it('returns empty for a clean diff', () => {
    expect(extractDiffRegions(diffPng(50, 50, []), { scale: 1 })).toEqual([]);
  });
});
