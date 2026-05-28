// src/lib/replicate/segmentation-parity.ts
//
// An OBJECTIVE parity score for the section segmentation, used to tune a generic
// layout-analysis ruleset against a fixture corpus instead of eyeballing one page.
//
// It compares the extractor's SectionSpec[] against an INDEPENDENT structural read
// of the same snapshot — the page's real full-width background BANDS (sampled in
// the browser, separate from extractFull). The two should agree: a source band
// boundary that the extractor did not reproduce is a MERGE (the bug behind
// "Journey + Specialties" collapsing into one section); a section whose captured
// background is far (ΔE) from the source band it sits on is a color-fidelity miss.
//
// measureSourceBands runs in the browser (needs layout); scoreSegmentation is a
// pure function (unit-tested) so the scoring math is verifiable without a browser.

import type { Page } from 'playwright';
import { colorDeltaE2000 } from './color-delta.js';
import type { SectionSpec } from './section-extract.js';

export interface SourceBand {
  /** Absolute top/bottom (px from document top) of a constant-background stripe. */
  top: number;
  bottom: number;
  /** The band's effective opaque background as `rgb(r, g, b)`. */
  bg: string;
}

export interface ParityScore {
  sourceBandCount: number;
  sectionCount: number;
  /** Fraction of interior source-band boundaries the extractor reproduced (±tol). */
  boundaryRecall: number;
  /** Fraction of sections whose captured bg is within ΔE<=10 of its source band. */
  bgFidelity: number;
  /** Mean ΔE2000 between each section's bg and the source band at its y-center. */
  avgBgDeltaE: number;
  /** Weighted composite in [0,1] (higher = closer to the source structure). */
  composite: number;
}

/**
 * Read the snapshot's real visual bands: full-width, opaque-background stripes.
 * Geometry-only and independent of extractFull — at scroll 0 every element's
 * getBoundingClientRect is already in absolute document coordinates. For each
 * sampled y the band color is the INNERMOST (smallest-area) full-width opaque
 * block covering it (that's the layer the viewer sees); gaps read as white.
 * Adjacent equal-color samples compress into bands; sub-minBand stripes drop.
 */
export async function measureSourceBands(
  page: Page,
  opts: { stepPx?: number; minBandPx?: number; widthFrac?: number } = {},
): Promise<SourceBand[]> {
  const stepPx = opts.stepPx ?? 24;
  const minBandPx = opts.minBandPx ?? 120;
  const widthFrac = opts.widthFrac ?? 0.9;
  return page.evaluate(
    ({ stepPx, minBandPx, widthFrac }) => {
      const opaque = (v: string): string | null => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(v || '');
        if (!m) return null;
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (a < 0.5) return null;
        return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
      };
      const vw = window.innerWidth;
      const pageH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const blocks: Array<{ top: number; bottom: number; bg: string; area: number }> = [];
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const he = el as HTMLElement;
        if (he.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * widthFrac || r.height < 40) continue;
        const bg = opaque(getComputedStyle(el).backgroundColor);
        if (!bg) continue;
        blocks.push({ top: r.top, bottom: r.top + r.height, bg, area: r.width * r.height });
      }
      blocks.sort((a, b) => a.area - b.area); // innermost (smallest) wins a y
      const colorAt = (y: number): string => {
        for (const b of blocks) if (y >= b.top && y < b.bottom) return b.bg;
        return 'rgb(255, 255, 255)';
      };
      const bands: Array<{ top: number; bottom: number; bg: string }> = [];
      for (let y = 0; y < pageH; y += stepPx) {
        const bg = colorAt(y);
        const last = bands[bands.length - 1];
        if (last && last.bg === bg) last.bottom = y + stepPx;
        else bands.push({ top: y, bottom: y + stepPx, bg });
      }
      return bands.filter((b) => b.bottom - b.top >= minBandPx);
    },
    { stepPx, minBandPx, widthFrac },
  );
}

/**
 * Score how well the extracted sections reproduce the source's visual bands.
 * Pure: no browser, no I/O — unit-tested.
 */
export function scoreSegmentation(
  bands: SourceBand[],
  specs: SectionSpec[],
  opts: { boundaryTolPx?: number; deltaEFloor?: number } = {},
): ParityScore {
  const tol = opts.boundaryTolPx ?? 80;
  const deFloor = opts.deltaEFloor ?? 10;
  const sectionTops = specs.map((s) => s.top);

  // Interior source boundaries (the top of each band after the first): each should
  // align with some extracted section top. A merge drops a boundary → lower recall.
  const interior = bands.slice(1).map((b) => b.top);
  const matched = interior.filter((y) => sectionTops.some((t) => Math.abs(t - y) <= tol));
  const boundaryRecall = interior.length ? matched.length / interior.length : 1;

  // Per-section background fidelity vs the source band at the section's y-center.
  const bandAt = (y: number): SourceBand | null =>
    bands.find((b) => y >= b.top && y < b.bottom) ?? null;
  let deSum = 0;
  let dePass = 0;
  let scored = 0;
  for (const s of specs) {
    const band = bandAt(s.top + s.height / 2);
    if (!band) continue;
    const de = colorDeltaE2000(s.backgroundColor, band.bg);
    deSum += de;
    if (de <= deFloor) dePass++;
    scored++;
  }
  const bgFidelity = scored ? dePass / scored : 1;
  const avgBgDeltaE = scored ? deSum / scored : 0;

  // Composite: segmentation correctness (boundary recall) weighted with color fidelity.
  const composite = 0.6 * boundaryRecall + 0.4 * bgFidelity;

  return {
    sourceBandCount: bands.length,
    sectionCount: specs.length,
    boundaryRecall: Number(boundaryRecall.toFixed(3)),
    bgFidelity: Number(bgFidelity.toFixed(3)),
    avgBgDeltaE: Number(avgBgDeltaE.toFixed(2)),
    composite: Number(composite.toFixed(3)),
  };
}
