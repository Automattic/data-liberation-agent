/**
 * src/lib/screenshot/fixups.ts
 * ============================
 * Modular registry of in-page DOM fixups for captured site chrome.
 *
 * Each fixup is a standalone function intended to run INSIDE the browser
 * via `page.evaluate` (or similar). Fixups are documented, independently
 * exportable, and composable into a named registry so additional per-builder
 * fixups are easy to add without touching callers.
 *
 * Integration pattern
 * -------------------
 * Because fixups run inside the browser, they cannot be imported directly as
 * live functions. Instead the caller serialises each fixup body via
 * `.toString()`, injects it into a `page.evaluate` string, and reconstructs
 * the call there. The `CHROME_FIXUP_SOURCE` export packages the source strings
 * for the two bundled fixups so callers have a single import point:
 *
 *   import { CHROME_FIXUP_SOURCE } from './fixups.js';
 *   page.evaluate(`
 *     const depinFixedSticky = ${CHROME_FIXUP_SOURCE.depinFixedSticky};
 *     const bakeComputedLayout = ${CHROME_FIXUP_SOURCE.bakeComputedLayout};
 *     // ... use them
 *   `);
 *
 * `applyChromeFixups` is the high-level convenience that composes both
 * fixups in the correct order (de-pin → bake). It is separately exported so
 * other callers can use it without importing the registry.
 */

// ---------------------------------------------------------------------------
// 1. depinFixedSticky — un-pin JS-managed fixed / sticky elements
// ---------------------------------------------------------------------------

/**
 * For `root` and every descendant whose computed `position` is `fixed` or
 * `sticky`, write `position:static; top:auto; left:auto; transform:none` as
 * inline styles.
 *
 * Rationale: navigation menus and announcement bars on JS-heavy sites (Wix,
 * Webflow, …) are positioned by JavaScript at capture time. Once JS is
 * stripped in the replica they collapse to 0×0. De-pinning before extraction
 * makes them flow in the document like regular block elements.
 *
 * NOTE: This function is designed to run INSIDE the browser. Export it for
 * use both in tests (via a jsdom-style environment) and for serialisation into
 * `page.evaluate`. Do NOT call it in Node process code directly.
 */
export function depinFixedSticky(root: Element): void {
  const els = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    const p = getComputedStyle(el as HTMLElement).position;
    if (p === 'fixed' || p === 'sticky') {
      (el as HTMLElement).style.position = 'static';
      (el as HTMLElement).style.top = 'auto';
      (el as HTMLElement).style.left = 'auto';
      (el as HTMLElement).style.transform = 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// 2. bakeComputedLayout — freeze JS-computed layout as inline styles
// ---------------------------------------------------------------------------

/**
 * Curated set of layout-related CSS properties to bake. The set is intentionally
 * bounded to avoid bloating the HTML with hundreds of properties per element.
 * Covers: box model, flex, grid, sizing, positioning, text flow, visibility.
 */
const BAKED_PROPS = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'box-sizing',
  'float',
  'clear',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-self',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row',
  'transform',
  'transform-origin',
  'overflow-x',
  'overflow-y',
  'z-index',
  'text-align',
  'vertical-align',
  'white-space',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'visibility',
  'opacity',
] as const;

/**
 * For `root` and every descendant, copy a curated set of computed layout
 * properties to inline `style` so the JS-computed layout is frozen and
 * renders pixel-identically without JS.
 *
 * IMPORTANT: when baking `position`, if the computed value is `fixed` or
 * `sticky` it is written as `static` instead — de-pinning is integrated so
 * baking a fixed element does not re-pin it. This means calling
 * `bakeComputedLayout` alone is sufficient; `depinFixedSticky` only needs to
 * be called separately when you want de-pin WITHOUT a full layout bake.
 *
 * Baked properties are appended to any existing inline `style` attribute (via
 * the element's `.style` property) so hand-authored inline styles are not
 * silently discarded.
 *
 * NOTE: This function is designed to run INSIDE the browser. Do NOT call it
 * in Node process code directly.
 */
export function bakeComputedLayout(root: Element): void {
  const props: readonly string[] = [
    'display',
    'position',
    'top',
    'right',
    'bottom',
    'left',
    'width',
    'height',
    'min-width',
    'min-height',
    'max-width',
    'max-height',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'box-sizing',
    'float',
    'clear',
    'flex-grow',
    'flex-shrink',
    'flex-basis',
    'flex-direction',
    'flex-wrap',
    'justify-content',
    'align-items',
    'align-self',
    'gap',
    'grid-template-columns',
    'grid-template-rows',
    'grid-column',
    'grid-row',
    'transform',
    'transform-origin',
    'overflow-x',
    'overflow-y',
    'z-index',
    'text-align',
    'vertical-align',
    'white-space',
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'visibility',
    'opacity',
  ];
  const els = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    const cs = getComputedStyle(el as HTMLElement);
    for (const prop of props) {
      let value = cs.getPropertyValue(prop);
      // De-pin: never bake fixed/sticky — write static instead so the element
      // flows in the replica without JS to manage its position.
      if (prop === 'position' && (value === 'fixed' || value === 'sticky')) {
        value = 'static';
        // Clear offset/transform so the now-static element doesn't inherit
        // stale JS-written offsets.
        (el as HTMLElement).style.setProperty('top', 'auto');
        (el as HTMLElement).style.setProperty('left', 'auto');
        (el as HTMLElement).style.setProperty('transform', 'none');
      }
      if (value) {
        (el as HTMLElement).style.setProperty(prop, value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. applyChromeFixups — composite fixup for the extracted chrome
// ---------------------------------------------------------------------------

/**
 * Apply the chrome fixup pipeline to a single root element:
 *   1. `depinFixedSticky(root)` — un-pin fixed/sticky descendants
 *   2. `bakeComputedLayout(root)` — freeze JS-computed layout as inline styles
 *      (bakeComputedLayout also handles de-pin for position, so the explicit
 *      depinFixedSticky pass covers transform/top/left on elements where bake
 *      might not reach before serialisation race conditions on some browsers)
 *
 * This is the single entry point for chrome extraction callers. The function
 * is designed to run INSIDE the browser.
 */
export function applyChromeFixups(root: Element): void {
  depinFixedSticky(root);
  bakeComputedLayout(root);
}

// ---------------------------------------------------------------------------
// Source strings for browser injection
// ---------------------------------------------------------------------------

/**
 * Individual function source strings, keyed by name.
 *
 * Used by tests and for documentation. For browser injection prefer
 * `CHROME_FIXUP_FACTORY_SOURCE` which is self-contained.
 */
export const CHROME_FIXUP_SOURCE = {
  depinFixedSticky: depinFixedSticky.toString(),
  bakeComputedLayout: bakeComputedLayout.toString(),
  applyChromeFixups: applyChromeFixups.toString(),
} as const;

/**
 * A self-contained factory source string.
 *
 * When evaluated with `new Function('return (' + factorySrc + '')()')` in
 * the browser, it returns a ready-to-call `applyChromeFixups(root)` function
 * with all dependencies embedded in its closure — no external names needed.
 *
 * `dom-capture.ts` passes this string as an argument to `page.evaluate` and
 * reconstructs the applier inside the browser via `new Function`. This keeps
 * `fixups.ts` as the single source of truth while avoiding serialisation
 * problems with closures that reference Node-side module exports.
 *
 * Usage:
 *   const { factorySrc } = CHROME_FIXUP_FACTORY_SOURCE;
 *   await page.evaluate(({ factorySrc }) => {
 *     const applyChromeFixups = new Function('return (' + factorySrc + ')')()();
 *     applyChromeFixups(document.querySelector('header'));
 *   }, { factorySrc });
 */

// Build the factory source by embedding the individual function source strings
// so the resulting string is fully self-contained in the browser context.
const _depinSrc = depinFixedSticky.toString();
const _bakeSrc = bakeComputedLayout.toString();

// The factory is an IIFE that captures the helper functions and returns the
// composite applier. It is designed to be evaluated as:
//   new Function('return (' + factorySrc + ')')()
// which returns the factory function; calling it returns the applier:
//   new Function('return (' + factorySrc + ')')()()
const _factorySrc = `(function() {
  var depinFixedSticky = (${_depinSrc});
  var bakeComputedLayout = (${_bakeSrc});
  return function applyChromeFixups(root) {
    depinFixedSticky(root);
    bakeComputedLayout(root);
  };
})`;

export const CHROME_FIXUP_FACTORY_SOURCE: { factorySrc: string } = {
  factorySrc: _factorySrc,
};

// Re-export the property list so tests can verify the exact set.
export { BAKED_PROPS };
