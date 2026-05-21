/**
 * fixups.test.ts
 * ==============
 * Playwright fixture tests for the modular chrome fixup registry (fixups.ts).
 *
 * Covers:
 *   - `bakeComputedLayout`: layout/box/flex/grid/text properties are frozen as
 *     inline styles; `position:fixed` children become `position:static`.
 *   - `depinFixedSticky`: standalone de-pin without layout bake.
 *   - `CHROME_FIXUP_FACTORY_SOURCE`: the self-contained factory string produces
 *     a working applier in the browser (composite de-pin + bake).
 *   - `BAKED_PROPS`: exported property list matches the expected set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  BAKED_PROPS,
  CHROME_FIXUP_FACTORY_SOURCE,
  CHROME_FIXUP_SOURCE,
  depinFixedSticky,
  bakeComputedLayout,
  applyChromeFixups,
} from './fixups.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

// ---------------------------------------------------------------------------
// Fixture: a flex container with known CSS + a position:fixed child.
// We use inline/class CSS so getComputedStyle returns predictable values.
// ---------------------------------------------------------------------------
const FIXTURE = `<!DOCTYPE html><html><head>
  <style>
    #container {
      display: flex;
      width: 960px;
      height: 80px;
      align-items: center;
      gap: 16px;
      background: #111;
    }
    #fixed-child {
      position: fixed;
      top: 0;
      left: 0;
      width: 200px;
      height: 40px;
    }
    #normal-child {
      font-size: 18px;
      font-weight: 700;
    }
  </style>
</head><body style="margin:0">
  <div id="container">
    <div id="fixed-child">Fixed nav item</div>
    <div id="normal-child">Normal nav item</div>
  </div>
</body></html>`;

// ---------------------------------------------------------------------------
// BAKED_PROPS export
// ---------------------------------------------------------------------------
describe('BAKED_PROPS', () => {
  it('includes the required layout/box/flex/text properties', () => {
    const required = [
      'display', 'position', 'width', 'height',
      'flex-direction', 'justify-content', 'align-items', 'gap',
      'grid-template-columns', 'grid-template-rows',
      'font-size', 'font-weight', 'color', 'visibility', 'opacity',
    ];
    for (const prop of required) {
      expect((BAKED_PROPS as readonly string[]).includes(prop), `BAKED_PROPS must include "${prop}"`).toBe(true);
    }
  });

  it('is bounded (<=60 properties) and excludes non-layout decorative properties', () => {
    expect(BAKED_PROPS.length).toBeLessThanOrEqual(60);
    const excluded = ['background-color', 'border', 'outline', 'cursor', 'list-style'];
    for (const prop of excluded) {
      expect((BAKED_PROPS as readonly string[]).includes(prop), `BAKED_PROPS must NOT include "${prop}"`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// exported fixup function shapes (Node-side — no browser needed)
// ---------------------------------------------------------------------------
describe('exported fixup function shapes', () => {
  it('depinFixedSticky is a named function', () => {
    expect(typeof depinFixedSticky).toBe('function');
    expect(depinFixedSticky.name).toBe('depinFixedSticky');
  });

  it('bakeComputedLayout is a named function', () => {
    expect(typeof bakeComputedLayout).toBe('function');
    expect(bakeComputedLayout.name).toBe('bakeComputedLayout');
  });

  it('applyChromeFixups is a named function', () => {
    expect(typeof applyChromeFixups).toBe('function');
    expect(applyChromeFixups.name).toBe('applyChromeFixups');
  });

  it('CHROME_FIXUP_SOURCE contains non-empty string for each fixup', () => {
    expect(typeof CHROME_FIXUP_SOURCE.depinFixedSticky).toBe('string');
    expect(CHROME_FIXUP_SOURCE.depinFixedSticky.length).toBeGreaterThan(100);
    expect(typeof CHROME_FIXUP_SOURCE.bakeComputedLayout).toBe('string');
    expect(CHROME_FIXUP_SOURCE.bakeComputedLayout.length).toBeGreaterThan(100);
    expect(typeof CHROME_FIXUP_SOURCE.applyChromeFixups).toBe('string');
    expect(CHROME_FIXUP_SOURCE.applyChromeFixups.length).toBeGreaterThan(50);
  });

  it('CHROME_FIXUP_FACTORY_SOURCE.factorySrc is a non-empty self-contained string', () => {
    expect(typeof CHROME_FIXUP_FACTORY_SOURCE.factorySrc).toBe('string');
    expect(CHROME_FIXUP_FACTORY_SOURCE.factorySrc.length).toBeGreaterThan(200);
    // The factory must be self-contained: it should embed the helper sources.
    expect(CHROME_FIXUP_FACTORY_SOURCE.factorySrc).toContain('depinFixedSticky');
    expect(CHROME_FIXUP_FACTORY_SOURCE.factorySrc).toContain('bakeComputedLayout');
    expect(CHROME_FIXUP_FACTORY_SOURCE.factorySrc).toContain('applyChromeFixups');
  });
});

// ---------------------------------------------------------------------------
// bakeComputedLayout — in-browser via CHROME_FIXUP_FACTORY_SOURCE
// ---------------------------------------------------------------------------
describe('bakeComputedLayout (via factory, Playwright fixture)', () => {
  it('bakes display, width, height from computed style onto the flex container', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    try {
      const { factorySrc } = CHROME_FIXUP_FACTORY_SOURCE;
      const containerStyle = await page.evaluate(({ factorySrc }: { factorySrc: string }) => {
        const makeApplier = new Function('return (' + factorySrc + ')')() as () => (root: Element) => void;
        const applyChromeFixups = makeApplier();
        const container = document.getElementById('container') as HTMLElement;
        applyChromeFixups(container);
        return container.getAttribute('style') ?? '';
      }, { factorySrc });

      expect(containerStyle).toMatch(/display:/);
      expect(containerStyle).toMatch(/width:\s*960px/);
      expect(containerStyle).toMatch(/height:\s*80px/);
      expect(containerStyle).toMatch(/align-items:/);
    } finally {
      await page.close();
    }
  });

  it('rewrites position:fixed on a child to position:static and clears top/left', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    try {
      const { factorySrc } = CHROME_FIXUP_FACTORY_SOURCE;
      const fixedChildStyle = await page.evaluate(({ factorySrc }: { factorySrc: string }) => {
        const makeApplier = new Function('return (' + factorySrc + ')')() as () => (root: Element) => void;
        const applyChromeFixups = makeApplier();
        const container = document.getElementById('container') as HTMLElement;
        applyChromeFixups(container);
        const fixedChild = document.getElementById('fixed-child') as HTMLElement;
        return fixedChild.getAttribute('style') ?? '';
      }, { factorySrc });

      // Fixed child must be de-pinned.
      expect(fixedChildStyle).toMatch(/position:\s*static/);
      // Chromium serialises top/right/bottom/left as the `inset` shorthand in
      // some versions; accept either the longhand or the shorthand form.
      const hasTopAuto = /top:\s*auto/.test(fixedChildStyle) || /inset:\s*auto/.test(fixedChildStyle);
      expect(hasTopAuto, 'top should be auto (or inset shorthand)').toBe(true);
      const hasLeftAuto = /left:\s*auto/.test(fixedChildStyle) || /inset:\s*auto/.test(fixedChildStyle);
      expect(hasLeftAuto, 'left should be auto (or inset shorthand)').toBe(true);
    } finally {
      await page.close();
    }
  });

  it('does NOT rewrite position to fixed/sticky on a statically-positioned child', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    try {
      const { factorySrc } = CHROME_FIXUP_FACTORY_SOURCE;
      const positionValue = await page.evaluate(({ factorySrc }: { factorySrc: string }) => {
        const makeApplier = new Function('return (' + factorySrc + ')')() as () => (root: Element) => void;
        const applyChromeFixups = makeApplier();
        const container = document.getElementById('container') as HTMLElement;
        applyChromeFixups(container);
        const normalChild = document.getElementById('normal-child') as HTMLElement;
        const style = normalChild.getAttribute('style') ?? '';
        const match = style.match(/position:\s*([^;]+)/);
        return match ? match[1].trim() : null;
      }, { factorySrc });

      expect(positionValue).not.toBe('fixed');
      expect(positionValue).not.toBe('sticky');
    } finally {
      await page.close();
    }
  });

  it('bakes font-size and font-weight onto text children', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    try {
      const { factorySrc } = CHROME_FIXUP_FACTORY_SOURCE;
      const normalChildStyle = await page.evaluate(({ factorySrc }: { factorySrc: string }) => {
        const makeApplier = new Function('return (' + factorySrc + ')')() as () => (root: Element) => void;
        const applyChromeFixups = makeApplier();
        const container = document.getElementById('container') as HTMLElement;
        applyChromeFixups(container);
        const normalChild = document.getElementById('normal-child') as HTMLElement;
        return normalChild.getAttribute('style') ?? '';
      }, { factorySrc });

      expect(normalChildStyle).toMatch(/font-size:\s*18px/);
      expect(normalChildStyle).toMatch(/font-weight:\s*700/);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// depinFixedSticky — standalone de-pin (CHROME_FIXUP_SOURCE injection)
// ---------------------------------------------------------------------------
describe('depinFixedSticky standalone (CHROME_FIXUP_SOURCE, Playwright fixture)', () => {
  it('de-pins fixed elements WITHOUT baking other layout props on the container', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    try {
      const depinSrc = CHROME_FIXUP_SOURCE.depinFixedSticky;
      const result = await page.evaluate(({ depinSrc }: { depinSrc: string }) => {
        const depinFixedSticky = new Function('return (' + depinSrc + ')')() as (root: Element) => void;
        const container = document.getElementById('container') as HTMLElement;
        depinFixedSticky(container);
        const fixedChild = document.getElementById('fixed-child') as HTMLElement;
        return {
          fixedChildStyle: fixedChild.getAttribute('style') ?? '',
          containerStyle: container.getAttribute('style') ?? '',
        };
      }, { depinSrc });

      // Fixed child is de-pinned.
      expect(result.fixedChildStyle).toMatch(/position:\s*static/);
      expect(result.fixedChildStyle).toMatch(/top:\s*auto/);
      expect(result.fixedChildStyle).toMatch(/left:\s*auto/);
      expect(result.fixedChildStyle).toMatch(/transform:\s*none/);
      // Container has no layout bake — width/height must NOT be in inline style.
      expect(result.containerStyle).not.toMatch(/width:/);
      expect(result.containerStyle).not.toMatch(/height:/);
    } finally {
      await page.close();
    }
  });
});
