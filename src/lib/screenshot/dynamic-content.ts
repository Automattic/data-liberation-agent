import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import type { CapturedDialogInteraction } from './interaction-capture.js';

// ---------------------------------------------------------------------------
// Dynamic / JS-app content handling for the capture phase.
//
// Some pages render their BODY from a third-party JS app AFTER load (reviews
// widgets like Loox/Yotpo, FAQ/help widgets, etc.). If we snapshot before they
// populate, the captured HTML is an empty placeholder — the carry then renders a
// blank body (see DISCOVERIES 2026-06-04, getsnooz reviews/FAQ at 0.24). These
// helpers (1) expand statically-collapsed content, (2) wait for known widgets to
// populate before snapshotting, and (3) assess whether a captured page ended up
// with a real body or an empty one (so the run can flag it instead of shipping it).
// ---------------------------------------------------------------------------

/**
 * Third-party content widgets whose body is injected by JS after page load. Container
 * selectors are valid CSS (usable in both cheerio and `querySelectorAll`). Extend freely
 * as new apps are encountered — this registry is the single source for Phase 2 + Phase 0.
 */
export interface KnownWidget {
  name: string;
  selector: string;
}
export const KNOWN_WIDGETS: KnownWidget[] = [
  { name: 'loox', selector: '#looxReviews, .loox-reviews, [id^="looxReviews"], [data-loox]' },
  { name: 'yotpo', selector: '.yotpo, [class*="yotpo-"]' },
  { name: 'judgeme', selector: '.jdgm-widget, .jdgm-rev-widg, [data-jdgm-widget]' },
  { name: 'okendo', selector: '[data-oke-widget], .okeReviews' },
  { name: 'stamped', selector: '#stamped-main-widget, .stamped-main-widget' },
  { name: 'reviews-io', selector: '#reviewsio-carousel-widget, .ruk_rating_snippet' },
  { name: 'zendesk', selector: 'iframe[src*="zendesk"], [id*="zendesk"]' },
  { name: 'gorgias', selector: 'iframe[src*="gorgias"]' },
  { name: 'elfsight', selector: '[class*="elfsight-app"]' },
];

const WIDGET_SELECTOR = KNOWN_WIDGETS.map((w) => w.selector).join(', ');

/**
 * Labels of an in-page expand toggle. Clicking one changes the author's first
 * view — the label flips, a clamp comes off — rather than injecting content
 * that the initial document does not already carry. The base document keeps
 * the collapsed state; `hydrateDisclosureContent` records the opened form.
 */
const EXPAND_TOGGLE_LABELS = ['show more', 'read more'];

/**
 * Phase 1 — hydrate statically-collapsed content. Native `<details>` retain their
 * resting state; their children are already authored HTML. Expands disclosure
 * panels without authored content (`[aria-expanded="false"][aria-controls]`),
 * and clicks "load more / view all" controls. Popup controls and
 * anchors with navigable hrefs are excluded so probing cannot leave the source document.
 * "Show more" / "read more" toggles are not activated here: leaving them open
 * serializes the expanded first view, and compare measures the source through
 * this same helper. Best-effort; never throws into the capture loop.
 */
export async function expandCollapsedContent(page: Page): Promise<void> {
  try {
    await page.evaluate(async (toggleLabels: string[]) => {
      const isExpandToggle = (element: Element) => {
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return toggleLabels.some((label) => text === label || text.startsWith(label));
      };
      // Site chrome (the page-level banner and contentinfo landmarks) holds
      // menus, not collapsed editorial content. A toggle there — a phone menu
      // button flipping `hidden` on a dropdown of links, for one — must keep its
      // resting state: every route serializes the same chrome, the interaction
      // probe records the opened form from a closed trigger, and shared chrome
      // parts are factored from those exact bytes. A header or footer inside a
      // sectioning element is local content and stays eligible.
      const inSiteChrome = (node: Element | null | undefined) => {
        for (let current = node ?? null; current; current = current.parentElement) {
          const role = current.getAttribute('role');
          if (role === 'banner' || role === 'contentinfo') return true;
          if (role || (current.tagName !== 'HEADER' && current.tagName !== 'FOOTER')) continue;
          if (!current.parentElement?.closest('article,aside,main,nav,section,[role="article"],[role="complementary"],[role="main"],[role="region"]')) return true;
        }
        return false;
      };
      const safeToActivate = (element: Element) => {
        // An authored chooser role overrides the native button's semantics.
        // Choices belong to post-baseline interaction capture, not hydration.
        if (element.matches('[role="listbox"],[role="combobox"],[role="menu"],[role="menuitem"],[role="option"]')) return false;
        if (element.hasAttribute('aria-haspopup')) return false;
        if (element.closest('nav,[role="navigation"]')) return false;
        if (inSiteChrome(element)) return false;
        const controlled = document.getElementById(element.getAttribute('aria-controls') || '');
        if (controlled?.closest('nav,[role="navigation"]') || controlled?.querySelector('nav,[role="navigation"]')) return false;
        if (inSiteChrome(controlled)) return false;
        // A submit control is never a disclosure: activating it submits its
        // form and unloads the page (a store's "View all" search button, for
        // one), which the route-revert below cannot undo.
        if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
          && element.type === 'submit' && element.form) return false;
        if (element.tagName !== 'A') return true;
        const rawHref = element.getAttribute('href');
        if (rawHref === null) return true;
        const href = rawHref.trim();
        return href === '#' || href.startsWith('#');
      };

      // safeToActivate is a STRUCTURAL pre-filter: it can tell an anchor with a
      // real destination from an in-page toggle, but a client-routed SPA's own
      // navigation controls are ordinary <button>s wired to the router via
      // onClick — nothing in the markup distinguishes that button from a
      // genuine "show more" disclosure before it is clicked. So the intent
      // ("only activate in-page disclosure affordances") is enforced by
      // OUTCOME as well: click, then check whether the document's route moved.
      // A control that navigates was never a disclosure — put the route back
      // (the SPA's own router intercepts history.pushState, which is how these
      // routers already observe programmatic navigation, so this is a generic
      // browser-API revert, not framework-specific) and stop touching anything
      // else on the page, since further probing on a page mid-navigation is
      // unsafe. This is generic and vendor-neutral: it only ever asks "did the
      // route change", never what framework produced it.
      const currentRoute = () => `${location.pathname}${location.search}`;
      // A route revert only works while this document survives. A plain
      // <button> whose handler loads another document (location.assign, a
      // scripted link click) would replace it outright, destroying this
      // evaluate and leaving capture on a different page. The Navigation API
      // announces every navigation this document starts, so cancel the ones
      // that would leave it; same-document ones (pushState) still run and
      // are reverted below.
      type NavigateEvent = Event & { destination?: { sameDocument?: boolean } };
      const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
      let blockedNavigation = false;
      const keepDocument = (event: Event) => {
        if (!event.cancelable || (event as NavigateEvent).destination?.sameDocument) return;
        event.preventDefault();
        blockedNavigation = true;
      };
      navigation?.addEventListener('navigate', keepDocument);
      const activate = async (element: Element): Promise<'ok' | 'navigated'> => {
        const before = currentRoute();
        const beforeState = history.state;
        try { (element as HTMLElement).click(); } catch { return 'ok'; }
        // Let a synchronous router (the common case) act before checking.
        await new Promise((r) => setTimeout(r, 60));
        if (blockedNavigation) return 'navigated';
        if (currentRoute() === before) return 'ok';
        try {
          history.pushState(beforeState, '', before);
          window.dispatchEvent(new PopStateEvent('popstate', { state: beforeState }));
        } catch { /* ignore */ }
        for (let attempt = 0; attempt < 20 && currentRoute() !== before; attempt++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        return 'navigated';
      };

      // Prime lazy image requests without opening native disclosures (including
      // exclusive named groups). Retain the author's loading hint after decoding.
      await Promise.all(Array.from(document.querySelectorAll<HTMLImageElement>('details:not([open]) img[loading="lazy"]')).map(async (image) => {
        image.loading = 'eager';
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            image.decode().catch(() => undefined),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); }),
          ]);
        } finally {
          clearTimeout(timer);
          image.setAttribute('loading', 'lazy');
        }
      }));

      const populatedResting = new Set<HTMLElement>();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-expanded][aria-controls]'))) {
        if (!safeToActivate(el) || isExpandToggle(el)) continue;
        // The panel is the nearest unique id match above the trigger: a card
        // heading's button and its region are often cousins, not siblings.
        const controls = el.getAttribute('aria-controls') || '';
        let panel: Element | undefined;
        for (let scope = el.parentElement; scope && !panel; scope = scope === document.body ? null : scope.parentElement) {
          const matches = Array.from(scope.querySelectorAll('[id]')).filter((node) => node.id === controls);
          if (matches.length > 1) break;
          panel = matches[0];
        }
        if (!panel || panel.getAttribute('role') !== 'region') continue;
        if (!((panel.textContent || '').trim() || panel.querySelector('img,video,audio,picture,svg,canvas'))) continue;
        populatedResting.add(el);
      }
      // Populated editorial regions already carry their content. Opening them
      // here used to restore only exclusive groups, leaving independent cards
      // expanded before baseline observation. The disclosure pass owns their
      // open → observe → restore proof and the local replay contract.
      let navigated = false;
      for (const el of Array.from(document.querySelectorAll('[aria-expanded="false"][aria-controls]'))) {
        if (navigated) break;
        if (!safeToActivate(el) || isExpandToggle(el) || populatedResting.has(el as HTMLElement)) continue;
        if ((await activate(el)) === 'navigated') navigated = true;
        // A panel the runtime mounts only on activation could not be checked
        // above. Once mounted, a navigation panel is a menu, not collapsed
        // content: close it so the resting chrome is what gets serialized.
        else if (!safeToActivate(el)) await activate(el);
      }

      if (!navigated) {
        // Content injection, not a reversible first-view toggle. "show more" /
        // "read more" stay collapsed; their opened form is a disclosure state.
        const labels = ['load more', 'show all', 'view all', 'see all', 'expand all'];
        for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
          if (navigated) break;
          const t = (el.textContent || '').trim().toLowerCase();
          if (!safeToActivate(el) || isExpandToggle(el) || !t || !labels.some((l) => t === l || t.startsWith(l))) continue;
          if ((await activate(el)) === 'navigated') navigated = true;
        }
      }

      await new Promise((r) => setTimeout(r, 400));
      navigation?.removeEventListener('navigate', keepDocument);
    }, EXPAND_TOGGLE_LABELS);
  } catch { /* page blocked our script — don't fail the capture */ }
}

// Includes populated panels as well as lazy mounts; keep typical card lists
// (including lists longer than 32 items) on the same bounded restore contract.
const MAX_DISCLOSURE_CANDIDATES = 64;
const MAX_EXPAND_TOGGLES = 8;
const MAX_DISCLOSURE_HTML_BYTES = 512 * 1024;
/** How long the restore step will wait for a runtime's own close-unmount to land
 *  before giving up (see `hydrateDisclosureContent` — the Radix Presence exit case). */
const MAX_DISCLOSURE_SETTLE_MS = 1000;

/** Raw, plain-object shape returned across the `page.evaluate` boundary — see
 *  `hydrateDisclosureContent` for how this is folded into a `CapturedDialogInteraction`. */
interface RawDisclosureRecord {
  status: 'captured' | 'no-dialog' | 'click-failed';
  trigger: { selector: string; tag: string; id?: string; label?: string };
  target: { selector: string; tag: string; id?: string };
  html?: string;
  error?: string;
}

function boundDisclosureHtml(html: string): { html: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(html);
  if (bytes <= MAX_DISCLOSURE_HTML_BYTES) return { html, bytes, truncated: false };
  return { html: Buffer.from(html).subarray(0, MAX_DISCLOSURE_HTML_BYTES).toString(), bytes, truncated: true };
}

// One page-owned bridge: DOM-dispatched keyboard events do not reproduce a real
// Escape press (including legacy keyCode handlers). Reuse it across root probes.
const disclosureEscapeBindings = new WeakMap<Page, Promise<string>>();
async function disclosureEscapeBinding(page: Page): Promise<string> {
  let binding = disclosureEscapeBindings.get(page);
  if (!binding) {
    binding = (async () => {
      const name = `__disclosureEscape_${randomUUID().replaceAll('-', '')}`;
      await page.exposeBinding(name, () => page.keyboard.press('Escape'));
      return name;
    })();
    disclosureEscapeBindings.set(page, binding);
  }
  return binding;
}

/**
 * Preserve content that a disclosure runtime only mounts while one item is open —
 * FAQ/accordion panels being the common case. A runtime like Radix (shadcn/ui)
 * UNMOUNTS a collapsed panel's children entirely, so the served static markup is
 * an empty `<div role="region" hidden>`: the answer text exists only inside the
 * JS bundle and is otherwise silently lost from the captured page.
 *
 * Detection is purely ARIA-based — `aria-expanded` on the trigger plus either
 * `aria-controls` (the forward relationship) or, when a runtime never writes
 * `aria-controls` at all, the reverse relationship of a `role="region"` panel's
 * `aria-labelledby` pointing back at the trigger's id. No vendor/framework
 * attribute (e.g. `data-radix-*`) is used, so this generalizes to any ARIA
 * disclosure widget built the same way.
 *
 * Each candidate is expanded independently, its revealed content captured,
 * then RECLOSED before the next candidate runs — required for single-open
 * ("accordion") widgets, where opening item N can auto-collapse item N-1: by
 * capturing-then-restoring one at a time, an already-captured sibling being
 * auto-collapsed is harmless. Restoring a still-empty region back to its
 * observed content means the panel keeps its original `hidden`/`aria-expanded`
 * state (collapsed items stay visually collapsed) while its content is now
 * physically present in the DOM rather than lost to the `hidden` attribute.
 *
 * A panel that is already populated can still be invisible because an ancestor
 * clips it (height 0 and overflow hidden) or an inner node uses display none.
 * Those controls are observed and restored. Only concealment that reverses is
 * normalized onto the local `hidden` contract. Layout that does not reverse,
 * including header and tablet geometry, stays untouched. Exclusive groups are
 * assigned only after a source open/close proof. Duplicate ids resolve inside
 * the trigger's own parent, not document-wide.
 *
 * The restore deliberately WAITS (bounded — see `MAX_DISCLOSURE_SETTLE_MS`) for
 * a runtime that unmounts closed panels to finish its exit animation first:
 * such a runtime (Radix Presence) keeps the panel's children mounted ~200ms
 * after the close, so restoring immediately would misread the transient mount
 * as "content survived" and skip the write-back, letting the pending unmount
 * delete the panel's only copy of its content.
 *
 * Runs in the baseline serialization transaction so the captured static HTML
 * contains the restored panels directly. Authored chooser roles belong to the
 * later interaction pass; they do not need editorial-content hydration. An
 * unassociated local mount must restore the observed baseline before its copy
 * is retained. An unverified mutation throws to the viewport's baseline reload
 * recovery instead of letting the screenshot/HTML transaction save the altered page.
 *
 * The same candidate pass also includes visible "show more" / "read more"
 * toggles. Those are not left open by `expandCollapsedContent`: the opened
 * form is recorded here and the collapsed label is put back. A second click
 * is the restore; a one-way handler is put back from the pre-click snapshot.
 *
 * Non-ARIA click accordions (#901) — repeated sibling items whose own click
 * reveals a hidden descendant, independently and reversibly — are proven the
 * same way and emitted on the same local-disclosure contract.
 *
 * Returns per-candidate diagnostics folded into `interaction-states.json`
 * alongside dialog/menu captures (`kind: 'disclosure'`) so this work is
 * observable with the same `candidate_count`/`captured_count` conventions.
 */
export async function hydrateDisclosureContent(page: Page, rootSelector = 'body'): Promise<CapturedDialogInteraction[]> {
  let raw: RawDisclosureRecord[];
  try {
    const escapeBinding = await disclosureEscapeBinding(page);
    const result = await page.evaluate(async ({ limit, settleMs, labels, toggleLimit, rootSelector, escapeBinding }: { limit: number; settleMs: number; labels: string[]; toggleLimit: number; rootSelector: string; escapeBinding: string }) => {
      const root = document.querySelector(rootSelector);
      if (!root) return [];
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const hasContent = (element: Element) =>
        Boolean((element.textContent || '').trim()) ||
        Boolean(element.querySelector('img,video,audio,picture,svg,canvas'));
      const cssEscape = (value: string) =>
        globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const elementPath = (element: Element): string => {
        const parts: string[] = [];
        for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
          const tag = node.tagName.toLowerCase();
          const siblings = node.parentElement
            ? Array.from(node.parentElement.children).filter((sibling) => sibling.tagName === node!.tagName)
            : [];
          parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
        }
        return `body > ${parts.join(' > ')}`;
      };
      const describe = (element: Element) => ({
        selector: element.id ? `#${cssEscape(element.id)}` : elementPath(element),
        tag: element.tagName.toLowerCase(),
        ...(element.id ? { id: element.id } : {}),
      });
      const labelOf = (element: Element) => (element.textContent || '').replace(/\s+/g, ' ').trim();
      const describeTrigger = (element: HTMLElement) => {
        const label = (element.getAttribute('aria-label') || labelOf(element)).slice(0, 40);
        return { ...describe(element), ...(label ? { label } : {}) };
      };
      const isCollapseLabel = (text: string) => /^(?:show|read) less\b/.test(text);
      const isExpandToggle = (element: Element) => {
        const text = labelOf(element).toLowerCase();
        return labels.some((label) => text === label || text.startsWith(label));
      };
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const safeToActivate = (element: Element) => {
        if (element.matches('[role="listbox"],[role="combobox"],[role="menu"],[role="menuitem"],[role="option"]')) return false;
        if (element.hasAttribute('aria-haspopup')) return false;
        if (element.closest('nav,[role="navigation"]')) return false;
        const controlled = document.getElementById(element.getAttribute('aria-controls') || '');
        if (controlled?.closest('nav,[role="navigation"]') || controlled?.querySelector('nav,[role="navigation"]')) return false;
        if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
          && element.type === 'submit' && element.form) return false;
        if (element.tagName !== 'A') return true;
        const href = (element.getAttribute('href') ?? '').trim();
        return href === '' || href === '#' || href.startsWith('#');
      };
      const scopeOf = (trigger: HTMLElement): HTMLElement => {
        const parent = trigger.parentElement;
        if (parent && parent !== document.body && parent !== document.documentElement) return parent;
        const controlled = document.getElementById(trigger.getAttribute('aria-controls') || '');
        if (controlled) return controlled;
        const previous = trigger.previousElementSibling;
        return previous instanceof HTMLElement ? previous : trigger;
      };
      const currentRoute = () => `${location.pathname}${location.search}`;
      const collapsedToggle = (button: HTMLElement, initial: string) => {
        if (!button.isConnected || button.getAttribute('aria-expanded') === 'true') return false;
        const text = labelOf(button).toLowerCase();
        return !isCollapseLabel(text) && (text === initial || text.startsWith(initial));
      };
      const handledToggles = new Set<string>();

      /** Generic ARIA disclosure candidates: aria-expanded + either aria-controls
       *  (forward) or a role="region" panel's aria-labelledby back to the trigger
       *  (reverse — the pattern a runtime that unmounts closed panels leaves behind,
       *  since it never bothers writing aria-controls on the trigger at all). */
      const findCandidates = (): Array<{ trigger: HTMLElement; target: HTMLElement; snapshot?: boolean; mounted?: boolean }> => {
        const seen = new Set<HTMLElement>();
        const out: Array<{ trigger: HTMLElement; target: HTMLElement; snapshot?: boolean; mounted?: boolean }> = [];
        root
          .querySelectorAll<HTMLElement>('[aria-expanded="false"][aria-controls]:not([aria-haspopup])')
          .forEach((trigger) => {
            const id = trigger.getAttribute('aria-controls') || '';
            const target = id ? document.getElementById(id) : null;
            if (target && target.getAttribute('role') === 'region' && !seen.has(trigger) && safeToActivate(trigger)) {
              seen.add(trigger);
              out.push({ trigger, target });
            }
          });
        root.querySelectorAll<HTMLElement>('[role="region"][aria-labelledby]').forEach((target) => {
          const id = target.getAttribute('aria-labelledby') || '';
          const trigger = id ? (document.getElementById(id) as HTMLElement | null) : null;
          if (
            trigger &&
            !seen.has(trigger) &&
            trigger.getAttribute('aria-expanded') === 'false' &&
            safeToActivate(trigger)
          ) {
            seen.add(trigger);
            out.push({ trigger, target });
          }
        });
        // An aria-expanded control can mount its entire panel on activation,
        // leaving neither a controlled ID nor a region in the resting DOM.
        // Only probe a bounded local item with exactly one disclosure control;
        // an observed new sibling, rather than its label/class, identifies it.
        root.querySelectorAll<HTMLElement>('button[aria-expanded="false"]:not([aria-haspopup]),[role="button"][aria-expanded="false"]:not([aria-haspopup])').forEach(trigger => {
          if (seen.has(trigger) || handledToggles.has(describe(trigger).selector) || !visible(trigger) || !safeToActivate(trigger)) return;
          if (document.getElementById(trigger.getAttribute('aria-controls') || '')) return;
          const target = scopeOf(trigger);
          if (target === trigger || target.querySelectorAll('[aria-expanded]').length !== 1) return;
          seen.add(trigger);
          out.push({ trigger, target, mounted: true });
        });
        const hydrating = new Set(out.filter((candidate) => candidate.mounted || !hasContent(candidate.target)).map((candidate) => candidate.trigger));
        for (const node of root.querySelectorAll<HTMLElement>('button, [role="button"]')) {
          if (hydrating.has(node) || handledToggles.has(describe(node).selector)) continue;
          if (!visible(node) || !safeToActivate(node) || !isExpandToggle(node)) continue;
          out.push({ trigger: node, target: scopeOf(node), snapshot: true });
        }
        return out;
      };

      const records: RawDisclosureRecord[] = [];
      const mountedPanels: Array<{ trigger: HTMLElement; parent: HTMLElement; panel: HTMLElement }> = [];
      let hydrated = 0;
      let togglesDone = 0;
      for (let pass = 0; pass < 3 && hydrated < limit; pass++) {
        const found = findCandidates();
        const candidates = [
          ...found.filter((candidate) => !candidate.snapshot && (candidate.mounted || !hasContent(candidate.target))).slice(0, limit - hydrated),
          ...found.filter((candidate) => candidate.snapshot).slice(0, toggleLimit - togglesDone),
        ];
        if (candidates.length === 0) break;

        const observed: Array<{ target: HTMLElement; content: string; trigger: HTMLElement }> = [];
        for (const candidate of candidates) {
          const { trigger, target } = candidate;
          if (candidate.mounted) {
            handledToggles.add(describe(trigger).selector);
            // This unassociated button is admitted by a local mount/close proof.
            // A closed trigger alone does not prove its siblings survived. Read
            // the resting state before activation and verify it before retaining
            // a hidden panel; never manufacture a replacement baseline DOM.
            const restingState = () => JSON.stringify({
              text: document.body.innerText,
              route: currentRoute(),
              x: scrollX, y: scrollY,
              trigger: trigger.getBoundingClientRect().toJSON(),
              owner: target.getBoundingClientRect().toJSON(),
              controls: Array.from(document.querySelectorAll('input,select,textarea'), node => ({
                value: (node as HTMLInputElement).value,
                checked: node instanceof HTMLInputElement ? node.checked : undefined,
              })),
            });
            const resting = restingState();
            const before = new Set(Array.from(target.children));
            const closedIcons = Array.from(trigger.querySelectorAll('svg')).map(icon => ({className: icon.getAttribute('class') ?? '', style: icon.getAttribute('style') ?? ''}));
            const route = currentRoute();
            trigger.click();
            let panels: HTMLElement[] = [];
            for (let attempt = 0; attempt < 20; attempt++) {
              panels = Array.from(target.children).filter((child): child is HTMLElement => child instanceof HTMLElement && !before.has(child) && !child.contains(trigger) && hasContent(child) && visible(child));
              if (trigger.getAttribute('aria-expanded') === 'true' && panels.length === 1) break;
              await wait(50);
            }
            const panel = panels.length === 1 && currentRoute() === route && trigger.getAttribute('aria-expanded') === 'true' ? panels[0] : undefined;
            // An observed popup is interaction evidence, even when its opener
            // omitted aria-haspopup. Do not relabel a menu as an editorial region.
            const popup = panel?.matches('[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[popover]');
            const copy = !popup ? panel?.cloneNode(true) as HTMLElement | undefined : undefined;
            const openIcons = Array.from(trigger.querySelectorAll('svg')).map(icon => ({className: icon.getAttribute('class') ?? '', style: icon.getAttribute('style') ?? ''}));
            if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
            const deadline = Date.now() + settleMs;
            while (Date.now() < deadline && (trigger.getAttribute('aria-expanded') !== 'false' || panel?.isConnected)) await wait(25);
            if (copy && trigger.getAttribute('aria-expanded') === 'false' && !panel?.isConnected && restingState() === resting) {
              const icons = Array.from(trigger.querySelectorAll('svg'));
              if (icons.length === closedIcons.length && icons.length === openIcons.length) icons.forEach((icon,index) => {
                const closed = closedIcons[index]!, open = openIcons[index]!;
                if ((icon.getAttribute('class') ?? '') !== closed.className || (icon.getAttribute('style') ?? '') !== closed.style) return;
                if (closed.className !== open.className) {
                  icon.setAttribute('data-blocks-engine-capture-disclosure-open-class',open.className);
                  icon.setAttribute('data-blocks-engine-capture-disclosure-closed-class',closed.className);
                }
                if (closed.style !== open.style) {
                  icon.setAttribute('data-blocks-engine-capture-disclosure-open-style',open.style);
                  icon.setAttribute('data-blocks-engine-capture-disclosure-closed-style',closed.style);
                }
              });
              mountedPanels.push({ trigger, parent: target, panel: copy });
              hydrated++;
            } else {
              // Serialization cannot treat an unsuccessful live probe as an
              // unchanged baseline. The caller owns the existing viewport
              // failure lifecycle; abort before later probes or write-back.
              if (trigger.getAttribute('aria-expanded') !== 'false' || restingState() !== resting) {
                await (window as unknown as Record<string, () => Promise<void>>)[escapeBinding]();
                const deadline = Date.now() + settleMs;
                while (Date.now() < deadline && (trigger.getAttribute('aria-expanded') !== 'false' || restingState() !== resting)) await wait(25);
              }
              if (trigger.getAttribute('aria-expanded') !== 'false' || restingState() !== resting) {
                // failure-class: representability:profile
                throw new Error(`${describe(trigger).selector}: no unique locally mounted panel with verified baseline restoration`);
              }
              records.push({ status: 'no-dialog', trigger: describeTrigger(trigger), target: describe(target), error: 'No unique locally mounted panel; baseline restoration verified.' });
            }
            continue;
          }
          if (candidate.snapshot) {
            const described = describeTrigger(trigger);
            const describedTarget = describe(target);
            handledToggles.add(described.selector);
            togglesDone++;
            const beforeHtml = target.outerHTML;
            const initial = labelOf(trigger).toLowerCase();
            const beforeRoute = currentRoute();
            const beforeState = history.state;
            try {
              trigger.click();
            } catch (error) {
              records.push({
                status: 'click-failed',
                trigger: described,
                target: describedTarget,
                error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
              });
              continue;
            }
            await wait(60);
            if (currentRoute() !== beforeRoute) {
              try {
                history.pushState(beforeState, '', beforeRoute);
                window.dispatchEvent(new PopStateEvent('popstate', { state: beforeState }));
              } catch { /* ignore */ }
              for (let attempt = 0; attempt < 20 && currentRoute() !== beforeRoute; attempt++) await wait(25);
              records.push({ status: 'no-dialog', trigger: described, target: describedTarget });
              break;
            }
            let openedHtml = '';
            for (let attempt = 0; attempt < 20 && !openedHtml; attempt++) {
              const text = labelOf(trigger).toLowerCase();
              if (trigger.getAttribute('aria-expanded') === 'true' || isCollapseLabel(text) || (target.isConnected && target.outerHTML !== beforeHtml)) {
                openedHtml = target.isConnected ? target.outerHTML : beforeHtml;
              } else await wait(50);
            }
            if (!openedHtml) {
              if (target.isConnected && target.outerHTML !== beforeHtml) target.outerHTML = beforeHtml;
              records.push({ status: 'no-dialog', trigger: described, target: describedTarget });
              continue;
            }
            try { trigger.click(); } catch { /* one-way handler: snapshot restore below */ }
            for (let attempt = 0; attempt < 10 && trigger.isConnected && !collapsedToggle(trigger, initial); attempt++) await wait(50);
            if (target.isConnected && !collapsedToggle(trigger, initial)) target.outerHTML = beforeHtml;
            records.push({ status: 'captured', trigger: described, target: describedTarget, html: openedHtml });
            continue;
          }
          try {
            trigger.click();
          } catch (error) {
            records.push({
              status: 'click-failed',
              trigger: describeTrigger(trigger),
              target: describe(target),
              error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            });
            continue;
          }
          for (let attempt = 0; attempt < 20; attempt++) {
            if (trigger.getAttribute('aria-expanded') === 'true' && hasContent(target)) break;
            await wait(50);
          }
          if (trigger.getAttribute('aria-expanded') !== 'true' || !hasContent(target)) {
            records.push({ status: 'no-dialog', trigger: describeTrigger(trigger), target: describe(target) });
            continue;
          }

          const content = target.innerHTML;
          trigger.click();
          for (let attempt = 0; attempt < 10; attempt++) {
            if (trigger.getAttribute('aria-expanded') === 'false') break;
            await wait(50);
          }
          await wait(50);
          observed.push({ target, content, trigger });
        }
        // A runtime like Radix keeps a just-closed panel's children mounted through
        // its exit animation (Presence) and unmounts them only ~200ms LATER. The
        // restore guard below reads a still-mounted panel as "already has content"
        // and skips the write-back — and the pending unmount then deletes the
        // panel's only copy of its content. The most recently closed item always
        // loses this race (every earlier item's unmount has landed by the time the
        // restore loop runs), which is why the LAST accordion item shipped empty
        // while the rest survived. So wait — bounded, concurrently for all observed
        // panels — for a transient exit mount to clear before restoring. A runtime
        // that never unmounts closed panels simply runs out the deadline here and
        // is left untouched by the guard below, exactly as before.
        const settleDeadline = Date.now() + settleMs;
        const pending = observed.filter((entry) => hasContent(entry.target));
        while (pending.length > 0 && Date.now() < settleDeadline) {
          for (let i = pending.length - 1; i >= 0; i--) {
            if (!hasContent(pending[i].target)) pending.splice(i, 1);
          }
          if (pending.length > 0) await wait(25);
        }
        for (const { target, content, trigger } of observed) {
          if (!hasContent(target)) target.innerHTML = content;
          target.dataset.blocksEngineCaptureHydratedDisclosure = 'true';
          records.push({
            status: 'captured',
            trigger: describeTrigger(trigger),
            target: describe(target),
            html: target.outerHTML,
          });
        }
        hydrated += observed.length;
        await wait(100);
      }
      const exclusiveGroups = new Set<HTMLElement>();
      const groups = new Map<HTMLElement, typeof mountedPanels>();
      for (const entry of mountedPanels) {
        const group = entry.parent.parentElement;
        if (group) groups.set(group, [...(groups.get(group) ?? []), entry]);
      }
      for (const [group, entries] of groups) {
        if (entries.length < 2) continue;
        const first = entries[0].trigger;
        const second = entries[1].trigger;
        const before = new Set(entries.flatMap(entry => Array.from(entry.parent.children)));
        first.click();
        await wait(60);
        if (first.getAttribute('aria-expanded') !== 'true') continue;
        second.click();
        await wait(60);
        if (second.getAttribute('aria-expanded') === 'true' && first.getAttribute('aria-expanded') === 'false') exclusiveGroups.add(group);
        for (const trigger of [first, second]) if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
        const deadline = Date.now() + settleMs;
        while (Date.now() < deadline && entries.some(entry => Array.from(entry.parent.children).some(child => !before.has(child)))) await wait(25);
      }
      // Write back only after all source interactions. A single-open runtime
      // can unmount siblings when the next item opens, including DOM we added.
      for (const { trigger, parent, panel } of mountedPanels) {
        if (!trigger.isConnected || !parent.isConnected) continue;
        let index = 0;
        while (document.getElementById(`data-blocks-engine-capture-disclosure-panel-${index}`)) index++;
        panel.id = `data-blocks-engine-capture-disclosure-panel-${index}`;
        panel.hidden = true;
        panel.setAttribute('role', 'region');
        panel.dataset.blocksEngineCaptureHydratedDisclosure = 'true';
        panel.dataset.blocksEngineCaptureLocalDisclosure = 'true';
        const group = parent.parentElement;
        if (group && exclusiveGroups.has(group)) group.dataset.blocksEngineCaptureExclusiveDisclosures = 'true';
        trigger.setAttribute('aria-controls', panel.id);
        parent.append(panel);
        records.push({ status: 'captured', trigger: describeTrigger(trigger), target: describe(panel), html: panel.outerHTML });
      }
      const matchesIn = (scope: ParentNode, id: string) => Array.from(scope.querySelectorAll<HTMLElement>('[id]')).filter((element) => element.id === id);
      const panelForTrigger = (trigger: HTMLElement): HTMLElement | null => {
        const id = trigger.getAttribute('aria-controls') || '';
        if (!id) return null;
        let scope: HTMLElement | null = trigger.parentElement;
        while (scope) {
          const matches = matchesIn(scope, id);
          if (matches.length === 1) return matches[0]!;
          if (matches.length > 1) return null;
          if (scope === root || scope === document.body) break;
          scope = scope.parentElement;
        }
        return null;
      };
      const clipped = (element: HTMLElement) => {
        for (let node: HTMLElement | null = element; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0 || node.hasAttribute('hidden')) return true;
          const overflow = style.overflowY || style.overflow;
          if ((overflow === 'hidden' || overflow === 'clip') && node.getBoundingClientRect().height < 1) return true;
        }
        return element.getBoundingClientRect().height < 1;
      };
      const concealmentNodes = (panel: HTMLElement, trigger: HTMLElement) => {
        const nodes = [panel];
        for (let node = panel.parentElement; node && !node.contains(trigger); node = node.parentElement) nodes.push(node);
        return nodes;
      };
      const clipState = (node: HTMLElement) => {
        const style = getComputedStyle(node);
        return {
          display: style.display,
          opacity: style.opacity,
          // A zero-row grid can clip through an overflow-hidden child rather
          // than the panel itself. The open/close proof below still must show
          // that this zero geometry reverses before it is normalized.
          heightZero: node.getBoundingClientRect().height < 1,
          className: node.getAttribute('class') || '',
          inlineDisplay: node.style.display,
          inlineOpacity: node.style.opacity,
        };
      };
      const clusterOf = (trigger: HTMLElement) => {
        let node = trigger.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
          const triggers = Array.from(node.querySelectorAll<HTMLElement>('[aria-expanded][aria-controls]:not([aria-haspopup])'));
          if (triggers.length >= 2 && triggers.includes(trigger)) return node;
          node = node.parentElement;
        }
        return null;
      };
      const populated: Array<{ trigger: HTMLElement; panel: HTMLElement }> = [];
      for (const trigger of Array.from(root.querySelectorAll<HTMLElement>('[aria-expanded][aria-controls]:not([aria-haspopup])'))) {
        if (populated.length >= limit - hydrated || !visible(trigger) || !safeToActivate(trigger) || isExpandToggle(trigger)) continue;
        const panel = panelForTrigger(trigger);
        if (!panel || panel.getAttribute('role') !== 'region' || !hasContent(panel)) continue;
        if (panel.dataset.blocksEngineCaptureLocalDisclosure || panel.dataset.blocksEngineCaptureHydratedDisclosure) continue;
        populated.push({ trigger, panel });
      }
      const eligible = populated.filter((pair) => {
        if (clipped(pair.panel)) return true;
        const cluster = clusterOf(pair.trigger);
        return Boolean(cluster && populated.some((other) => other !== pair && cluster.contains(other.trigger) && clipped(other.panel)));
      }).slice(0, limit - hydrated);
      const snapshotOf = (trigger: HTMLElement, panel: HTMLElement) => ({
        expanded: trigger.getAttribute('aria-expanded') === 'true',
        hidden: panel.hasAttribute('hidden'),
        ariaHidden: panel.getAttribute('aria-hidden'),
        inert: panel.hasAttribute('inert'),
        text: panel.textContent,
        controls: trigger.getAttribute('aria-controls') || '',
        parent: trigger.parentElement,
        nodes: concealmentNodes(panel, trigger).map((node) => ({ style: node.getAttribute('style'), className: node.getAttribute('class') })),
      });
      const resolveLive = (entry: { trigger: HTMLElement; panel: HTMLElement; snap: ReturnType<typeof snapshotOf> }) => {
        const controls = entry.snap.controls;
        const parent = entry.snap.parent;
        const trigger = entry.trigger.isConnected
          ? entry.trigger
          : (parent?.isConnected
            ? Array.from(parent.querySelectorAll<HTMLElement>('[aria-controls]')).find((item) => item.getAttribute('aria-controls') === controls)
            : undefined) || entry.trigger;
        const panel = trigger.isConnected ? panelForTrigger(trigger) : null;
        return { trigger, panel: panel || entry.panel };
      };
      const applySnap = (trigger: HTMLElement, panel: HTMLElement, snap: ReturnType<typeof snapshotOf>) => {
        if (!trigger.isConnected || !panel.isConnected) return;
        trigger.setAttribute('aria-expanded', snap.expanded ? 'true' : 'false');
        if (snap.hidden) panel.setAttribute('hidden', '');
        else panel.removeAttribute('hidden');
        if (snap.ariaHidden === null) panel.removeAttribute('aria-hidden');
        else panel.setAttribute('aria-hidden', snap.ariaHidden);
        panel.toggleAttribute('inert', snap.inert);
        concealmentNodes(panel, trigger).forEach((node, index) => {
          const item = snap.nodes[index];
          if (!item || !node.isConnected) return;
          if (item.style === null) node.removeAttribute('style');
          else node.setAttribute('style', item.style);
          if (item.className === null) node.removeAttribute('class');
          else node.setAttribute('class', item.className);
        });
      };
      const waitExpanded = async (trigger: HTMLElement, want: boolean) => {
        for (let attempt = 0; attempt < 20; attempt++) {
          if ((trigger.getAttribute('aria-expanded') === 'true') === want) return true;
          await wait(50);
        }
        return (trigger.getAttribute('aria-expanded') === 'true') === want;
      };
      const waitClip = async (panel: HTMLElement, wantClipped: boolean) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          if (panel.isConnected && clipped(panel) === wantClipped) return true;
          await wait(50);
        }
        return panel.isConnected && clipped(panel) === wantClipped;
      };
      type PopulatedEntry = {
        trigger: HTMLElement;
        panel: HTMLElement;
        snap: ReturnType<typeof snapshotOf>;
        closedClips: Array<ReturnType<typeof clipState>>;
        openClips: Array<ReturnType<typeof clipState>>;
      };
      const prepared = eligible.map(({ trigger, panel }) => ({ trigger, panel, snap: snapshotOf(trigger, panel) }));
      const forceResting = async (entry: (typeof prepared)[number]) => {
        const live = resolveLive(entry);
        if (live.trigger.isConnected && (live.trigger.getAttribute('aria-expanded') === 'true') !== entry.snap.expanded) {
          try { live.trigger.click(); } catch { /* the attribute restore below still returns the serialized control */ }
          for (let attempt = 0; attempt < 8 && (live.trigger.getAttribute('aria-expanded') === 'true') !== entry.snap.expanded; attempt++) await wait(50);
        }
        applySnap(live.trigger, live.panel, entry.snap);
        entry.trigger = live.trigger;
        entry.panel = live.panel;
      };
      const restorePrepared = async () => { for (const entry of prepared) await forceResting(entry); };
      const observedPopulated: PopulatedEntry[] = [];
      for (const entry of prepared) {
        const live = resolveLive(entry);
        entry.trigger = live.trigger;
        entry.panel = live.panel;
        const { trigger, panel, snap } = entry;
        const first = concealmentNodes(panel, trigger).map(clipState);
        const beforeRoute = currentRoute();
        let opened = false;
        try { trigger.click(); opened = true; } catch { await restorePrepared(); continue; }
        if (!opened || currentRoute() !== beforeRoute || !(await waitExpanded(trigger, !snap.expanded)) || !(await waitClip(panel, snap.expanded))) {
          records.push({ status: 'no-dialog', trigger: describeTrigger(resolveLive(entry).trigger), target: describe(resolveLive(entry).panel), error: 'Populated disclosure did not reveal.' });
          await restorePrepared();
          continue;
        }
        const second = concealmentNodes(panel, trigger).map(clipState);
        const revealed = !clipped(panel) === !snap.expanded;
        try { trigger.click(); } catch { await restorePrepared(); continue; }
        const reversed = await waitExpanded(trigger, snap.expanded) && await waitClip(panel, !snap.expanded) && panel.textContent === snap.text;
        await restorePrepared();
        if (currentRoute() !== beforeRoute || !revealed || !reversed) {
          records.push({ status: 'no-dialog', trigger: describeTrigger(entry.trigger), target: describe(entry.panel), error: 'Populated disclosure concealment did not reverse.' });
          continue;
        }
        observedPopulated.push({
          trigger: entry.trigger,
          panel: entry.panel,
          snap,
          closedClips: snap.expanded ? second : first,
          openClips: snap.expanded ? first : second,
        });
      }
      const grouped = new Map<HTMLElement, PopulatedEntry[]>();
      for (const entry of observedPopulated) {
        const cluster = clusterOf(entry.trigger);
        if (!cluster) continue;
        grouped.set(cluster, [...(grouped.get(cluster) ?? []), entry]);
      }
      const exclusiveClusters = new Set<HTMLElement>();
      for (const [cluster, entries] of grouped) {
        if (entries.length < 2) continue;
        const first = entries.find((entry) => !entry.snap.expanded) ?? entries[0]!;
        const second = entries.find((entry) => entry !== first);
        if (!second) continue;
        const beforeRoute = currentRoute();
        const firstLive = resolveLive(first);
        const secondLive = resolveLive(second);
        try { firstLive.trigger.click(); } catch { await restorePrepared(); continue; }
        if (currentRoute() !== beforeRoute || !(await waitExpanded(firstLive.trigger, true))) {
          await restorePrepared();
          continue;
        }
        try { secondLive.trigger.click(); } catch { await restorePrepared(); continue; }
        if (currentRoute() === beforeRoute && await waitExpanded(secondLive.trigger, true) && firstLive.trigger.getAttribute('aria-expanded') === 'false') exclusiveClusters.add(cluster);
        await restorePrepared();
      }
      const applyNormalized = (entry: PopulatedEntry) => {
        const live = resolveLive(entry);
        entry.trigger = live.trigger;
        entry.panel = live.panel;
        concealmentNodes(entry.panel, entry.trigger).forEach((node, index) => {
          if (node.contains(entry.trigger)) return;
          const closed = entry.closedClips[index];
          const opened = entry.openClips[index];
          if (!closed || !opened) return;
          if (closed.display === 'none' && opened.display !== 'none') {
            if (opened.inlineDisplay) node.style.display = opened.inlineDisplay;
            else node.style.removeProperty('display');
          }
          if (closed.opacity === '0' && opened.opacity !== '0') {
            if (opened.inlineOpacity) node.style.opacity = opened.inlineOpacity;
            else node.style.removeProperty('opacity');
          }
          if (closed.heightZero && !opened.heightZero) {
            node.style.height = 'auto';
            node.style.overflow = 'visible';
            const closedTokens = closed.className.split(/\s+/).filter(Boolean);
            const openTokens = opened.className.split(/\s+/).filter(Boolean);
            for (const token of closedTokens) if (!openTokens.includes(token)) node.classList.remove(token);
            for (const token of openTokens) if (!closedTokens.includes(token)) node.classList.add(token);
          }
        });
        entry.trigger.setAttribute('aria-expanded', entry.snap.expanded ? 'true' : 'false');
        entry.panel.hidden = !entry.snap.expanded;
        if (entry.snap.ariaHidden !== null) entry.panel.setAttribute('aria-hidden', entry.snap.expanded ? 'false' : 'true');
        entry.panel.dataset.blocksEngineCaptureLocalDisclosure = 'true';
        entry.panel.dataset.blocksEngineCaptureHydratedDisclosure = 'true';
        const cluster = clusterOf(entry.trigger);
        if (cluster && exclusiveClusters.has(cluster)) cluster.dataset.blocksEngineCaptureExclusiveDisclosures = 'true';
      };
      if (observedPopulated.length && !document.querySelector('style[data-blocks-engine-capture-local-disclosure]')) {
        const style = document.createElement('style');
        style.dataset.blocksEngineCaptureLocalDisclosure = 'true';
        style.textContent = '[data-blocks-engine-capture-local-disclosure][hidden]{display:none!important}';
        document.head.append(style);
      }
      for (const entry of observedPopulated) applyNormalized(entry);
      await wait(450);
      for (const entry of observedPopulated) applyNormalized(entry);
      for (const entry of prepared) {
        if (observedPopulated.some((observed) => observed.snap.controls === entry.snap.controls && observed.snap.text === entry.snap.text)) continue;
        await forceResting(entry);
      }
      for (const entry of observedPopulated) {
        records.push({ status: 'captured', trigger: describeTrigger(entry.trigger), target: describe(entry.panel), html: entry.panel.outerHTML });
      }
      // Non-ARIA click disclosures (#901): repeated sibling items whose own
      // activation reveals a previously hidden descendant of that item only.
      // The source proves each toggle is local (no mutation elsewhere in the
      // group), independent (an open item stays open while another opens) and
      // reversible (a second activation restores the item's markup, class token
      // order aside). Class/style differences become the contract's open/closed
      // swaps; a flipped leaf glyph outside the panel keeps its closed text. Any
      // other difference stays untouched and falls through to later probes.
      type NavigateEventLike = Event & { destination?: { sameDocument?: boolean } };
      const clickNavigation = (window as unknown as { navigation?: EventTarget }).navigation;
      let clickNavigationBlocked = false;
      const keepClickDocument = (event: Event) => {
        if (!event.cancelable || (event as NavigateEventLike).destination?.sameDocument) return;
        event.preventDefault();
        clickNavigationBlocked = true;
      };
      clickNavigation?.addEventListener('navigate', keepClickDocument);
      try {
        const clickDeadline = Date.now() + 15_000;
        const interactive = 'a,button,input,select,textarea,summary,details,label,option,[aria-expanded],[aria-haspopup],[role="tab"],[role="option"],[role="radio"],[role="menuitem"],[role="button"]';
        const clickable = (element: HTMLElement) => {
          if (element.matches(interactive) || element.closest('a,button,input,select,textarea,label,nav,[role="navigation"],details,[data-blocks-engine-capture-local-disclosure],[data-blocks-engine-capture-hydrated-disclosure],[aria-expanded]')) return false;
          if (element.querySelector('[aria-expanded],[data-blocks-engine-capture-local-disclosure],details')) return false;
          return element.hasAttribute('onclick') || element.matches('[data-action],[data-toggle],[data-target]') || getComputedStyle(element).cursor === 'pointer';
        };
        const concealed = (member: HTMLElement) => Array.from(member.querySelectorAll<HTMLElement>('*'))
          .filter((node) => hasContent(node) && clipped(node));
        const outermost = (nodes: HTMLElement[]) => nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
        const scanned = Array.from(root.querySelectorAll<HTMLElement>('*')).slice(0, 4000);
        const pointer = outermost(scanned.filter((element) => visible(element) && clickable(element)));
        const byParent = new Map<HTMLElement, HTMLElement[]>();
        for (const element of pointer) {
          const parent = element.parentElement;
          if (!parent || !concealed(element).length) continue;
          byParent.set(parent, [...(byParent.get(parent) ?? []), element]);
        }
        // Keep the existing group probe and its budgets. Controls without a
        // concealed descendant cannot prove a disclosure, but the same activation
        // can prove them inert. Batch those remaining controls as one group.
        const groupedPointers = new Set(Array.from(byParent.values()).flat());
        const ungrouped = pointer.filter(element => !groupedPointers.has(element));
        // Explicit hooks precede inherited pointer decoration in the bounded
        // remainder, so a live unrelated control cannot hide all later hooks.
        ungrouped.sort((a, b) => Number(b.matches('[data-action],[data-toggle],[data-target]')) - Number(a.matches('[data-action],[data-toggle],[data-target]')));
        if (ungrouped.length) byParent.set(root as HTMLElement, ungrouped);
        const inertControls = new Set<HTMLElement>();
        // Structure of an item apart from what the export can toggle (class and
        // style) and apart from leaf labels outside the panel: an icon whose
        // glyph flips (`+` to `×`) keeps its closed glyph in the copy.
        const childPath = (ancestor: Element, node: Element) => {
          const path: number[] = [];
          for (let current: Element = node; current !== ancestor && current.parentElement; current = current.parentElement) {
            path.unshift(Array.prototype.indexOf.call(current.parentElement.children, current));
          }
          return path;
        };
        const shape = (element: Element, panelPath: number[]) => {
          const clone = element.cloneNode(true) as Element;
          let panel: Element | undefined = clone;
          for (const index of panelPath) panel = panel?.children[index];
          for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
            node.removeAttribute('class');
            node.removeAttribute('style');
            if (node.childElementCount === 0 && panel && !panel.contains(node)) node.textContent = '';
          }
          return clone.outerHTML;
        };
        const presentation = (element: HTMLElement) => [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]
          .map((node) => ({ className: node.getAttribute('class'), style: node.getAttribute('style') }));
        const tokens = (value: string | null) => [...new Set((value ?? '').split(/\s+/).filter(Boolean))].sort().join(' ');
        const declarations = (value: string | null) => (value ?? '').replace(/\s*([:;,])\s*/g, '$1').replace(/;$/, '').trim();
        // A runtime that removes and re-adds a class token moves it to the end
        // of the attribute; token order and style spacing are not state.
        const canonical = (element: HTMLElement) => {
          const clone = element.cloneNode(true) as HTMLElement;
          for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
            const className = node.getAttribute('class');
            if (className !== null) node.setAttribute('class', [...new Set(className.split(/\s+/).filter(Boolean))].sort().join(' '));
            const style = node.getAttribute('style');
            if (style !== null) node.setAttribute('style', style.replace(/\s*([:;,])\s*/g, '$1').replace(/;$/, '').trim());
          }
          return clone.outerHTML;
        };
        const restoreGroup = async (members: HTMLElement[], initial: string[]) => {
          for (const [index, member] of members.entries()) {
            if (canonical(member) === initial[index]) continue;
            try { member.click(); } catch { /* verified below */ }
            for (let attempt = 0; attempt < 40 && canonical(member) !== initial[index]; attempt++) await wait(25);
          }
          if (members.some((member, index) => canonical(member) !== initial[index])) {
            // failure-class: representability:block
            throw new Error(`${describe(members[0]!.parentElement!).selector}: click disclosure group did not return to its baseline`);
          }
        };
        // Remainder controls share a window only when their #993 components
        // (their immediate parents) are disjoint. At most one control per
        // component is activated in a window, so local effects have one owner.
        // The 4000-node scan above is also the total remainder candidate bound.
        const proveRemainder = async () => {
        const solo: HTMLElement[] = [];
        let pending = ungrouped;
        while (pending.length && Date.now() < clickDeadline) {
          const batch: Array<{ member: HTMLElement; component: HTMLElement; baseline: string; geometry: string; effect: boolean }> = [];
          const next: HTMLElement[] = [];
          const geometry = (component: HTMLElement) => JSON.stringify([component, ...Array.from(component.querySelectorAll('*'))].map(node => {
            const style = getComputedStyle(node);
            return [node.getBoundingClientRect().toJSON(), style.display, style.visibility, style.opacity];
          }));
          for (const member of pending) {
            const component = member.parentElement ?? member;
            if (component === document.body || component === document.documentElement || concealed(member).length) {
              solo.push(member);
            } else if (batch.some(entry => entry.component.contains(component) || component.contains(entry.component))) {
              next.push(member);
            } else {
              batch.push({ member, component, baseline: canonical(component), geometry: geometry(component), effect: false });
            }
          }
          pending = next;
          if (!batch.length) continue;
          // A global/unattributable effect invalidates the entire shared window.
          // It is never evidence of inertness, even if it later reverts.
          let inconclusive = false;
          const beforeUrl = location.href;
          const beforeHistoryLength = history.length;
          const beforeHistoryState = JSON.stringify(history.state);
          const beforeState = history.state;
          const observe = (mutations: MutationRecord[]) => {
            for (const [index, mutation] of mutations.entries()) {
              if (mutation.type === 'attributes' && mutation.target instanceof Element) {
                const next = mutations.slice(index + 1).find(record => record.target === mutation.target && record.attributeName === mutation.attributeName);
                const value = next ? next.oldValue : mutation.target.getAttribute(mutation.attributeName!);
                if (mutation.oldValue === value) continue;
              }
              const owner = batch.find(entry => entry.component.contains(mutation.target));
              if (owner && mutation.target !== document.body && mutation.target !== document.documentElement) owner.effect = true;
              else inconclusive = true;
            }
          };
          const observer = new MutationObserver(observe);
          const methods = ['open', 'alert', 'confirm', 'prompt'] as const;
          const descriptors = methods.map(name => Object.getOwnPropertyDescriptor(window, name));
          const pushDescriptor = Object.getOwnPropertyDescriptor(history, 'pushState');
          const replaceDescriptor = Object.getOwnPropertyDescriptor(history, 'replaceState');
          const originalPush = history.pushState;
          const originalReplace = history.replaceState;
          const onNavigate = () => { inconclusive = true; };
          clickNavigationBlocked = false;
          observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
          try {
            for (const name of methods) Object.defineProperty(window, name, { configurable: true, writable: true, value: () => { inconclusive = true; return null; } });
            history.pushState = function(...args) { inconclusive = true; return originalPush.apply(this, args); };
            history.replaceState = function(...args) { inconclusive = true; return originalReplace.apply(this, args); };
            clickNavigation?.addEventListener('navigate', onNavigate);
            for (const entry of batch) {
              try { entry.member.click(); } catch { inconclusive = true; }
            }
            const activatedAt = Date.now();
            do {
              await wait(25);
              for (const entry of batch) if (geometry(entry.component) !== entry.geometry) entry.effect = true;
            } while (Date.now() - activatedAt < 400);
            observe(observer.takeRecords());
          } finally {
            observer.disconnect();
            clickNavigation?.removeEventListener('navigate', onNavigate);
            methods.forEach((name, index) => {
              const descriptor = descriptors[index];
              if (descriptor) Object.defineProperty(window, name, descriptor);
              else Reflect.deleteProperty(window, name);
            });
            if (pushDescriptor) Object.defineProperty(history, 'pushState', pushDescriptor);
            else Reflect.deleteProperty(history, 'pushState');
            if (replaceDescriptor) Object.defineProperty(history, 'replaceState', replaceDescriptor);
            else Reflect.deleteProperty(history, 'replaceState');
          }
          inconclusive ||= clickNavigationBlocked || location.href !== beforeUrl || history.length !== beforeHistoryLength || JSON.stringify(history.state) !== beforeHistoryState;
          if (location.href !== beforeUrl) {
            try {
              history.pushState(beforeState, '', beforeUrl);
              window.dispatchEvent(new PopStateEvent('popstate', { state: beforeState }));
            } catch { /* same best-effort route restoration as the solo probe */ }
          }
          for (const entry of batch) {
            // Restore the component, not just the trigger: a local handler can
            // change a sibling or its parent without changing the control itself.
            if (canonical(entry.component) !== entry.baseline) {
              try { entry.member.click(); } catch { /* verified below */ }
              for (let attempt = 0; attempt < 40 && canonical(entry.component) !== entry.baseline; attempt++) await wait(25);
              // A component that keeps changing on its own (a rotating carousel,
              // a clock) cannot return to a fixed baseline. Its control already
              // has an effect, so it is never marked inert; the capture goes on.
            }
            if (inconclusive) solo.push(entry.member);
            else if (!entry.effect && !entry.member.matches('a,button,input,select,textarea')
              && (entry.member.matches('[data-action],[data-toggle],[data-target]') || getComputedStyle(entry.member).cursor === 'pointer')) inertControls.add(entry.member);
          }
        }
        // Ambiguous shared windows use the existing solo proof and its retry
        // semantics. Do not let the old 24-member disclosure cap truncate them.
        solo.push(...pending);
        return solo;
        };
        let groupsProbed = 0;
        for (const [parent, groupMembers] of byParent) {
          if (groupsProbed >= 8 || Date.now() >= clickDeadline) continue;
          const candidates = parent === root ? await proveRemainder() : groupMembers;
          if (!candidates.length) continue;
          const tag = candidates[0]!.tagName;
          const members = candidates.filter((member) => parent === root || member.tagName === tag).slice(0, parent === root ? 4000 : 24);
          groupsProbed++;
          const retries = new Map<HTMLElement, number>();
          const initial = members.map(canonical);
          const resting = members.map((member) => member.cloneNode(true) as HTMLElement);
          const startRoute = currentRoute();
          const startState = history.state;
          const opened: Array<{ member: HTMLElement; panel: HTMLElement; open: ReturnType<typeof presentation> }> = [];
          let failure: string | undefined;
          // Open every member in turn without closing the earlier ones.
          for (const [memberIndex, member] of members.entries()) {
            if (Date.now() >= clickDeadline) { failure = 'probe budget exhausted'; break; }
            clickNavigationBlocked = false;
            const hiddenBefore = concealed(member);
            const foreign: Node[] = [];
            let mutated = false;
            let componentMutated = false;
            let browserEffect = false;
            const beforeUrl = location.href;
            const beforeHistoryLength = history.length;
            const beforeHistoryState = JSON.stringify(history.state);
            const component = member.parentElement ?? member;
            const geometry = () => JSON.stringify([component, ...Array.from(component.querySelectorAll('*'))].map(node => {
              const style = getComputedStyle(node);
              return [node.getBoundingClientRect().toJSON(), style.display, style.visibility, style.opacity];
            }));
            const beforeGeometry = geometry();
            let geometryChanged = false;
            const browserMethods = ['open', 'alert', 'confirm', 'prompt'] as const;
            const originals = browserMethods.map(name => Object.getOwnPropertyDescriptor(window, name));
            for (const name of browserMethods) Object.defineProperty(window, name, { configurable: true, writable: true, value: () => { browserEffect = true; return null; } });
            const onNavigate = () => { browserEffect = true; };
            clickNavigation?.addEventListener('navigate', onNavigate);
            const pushDescriptor = Object.getOwnPropertyDescriptor(history, 'pushState');
            const replaceDescriptor = Object.getOwnPropertyDescriptor(history, 'replaceState');
            const originalPush = history.pushState;
            const originalReplace = history.replaceState;
            history.pushState = function(...args) { browserEffect = true; return originalPush.apply(this, args); };
            history.replaceState = function(...args) { browserEffect = true; return originalReplace.apply(this, args); };
            // Inside the group, anything outside this item is foreign. Elsewhere,
            // only a newly mounted element or a root/body change (a modal, a
            // scroll lock) is: unrelated runtimes keep animating the page.
            const observeMutations = (mutations: MutationRecord[]) => {
              for (const [index, mutation] of mutations.entries()) {
                // Setting an attribute to its existing value queues a record too;
                // it is not an observable change. Compare successive old values
                // as well, so a transient change followed by a revert still counts.
                if (mutation.type === 'attributes' && mutation.target instanceof Element) {
                  const next = mutations.slice(index + 1).find(record => record.target === mutation.target && record.attributeName === mutation.attributeName);
                  const value = next ? next.oldValue : mutation.target.getAttribute(mutation.attributeName!);
                  if (mutation.oldValue === value) continue;
                }
                mutated = true;
                if (component.contains(mutation.target)) componentMutated = true;
                if (member.contains(mutation.target)) continue;
                if (parent.contains(mutation.target)) foreign.push(mutation.target);
                else if (mutation.target === document.body || mutation.target === document.documentElement) foreign.push(mutation.target);
                else if (Array.from(mutation.addedNodes).some((node) => node instanceof Element)) foreign.push(mutation.target);
              }
            };
            const observer = new MutationObserver(observeMutations);
            observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
            let revealed: HTMLElement[] = [];
            try {
              const activatedAt = Date.now();
              try { member.click(); } catch { failure = 'activation threw'; }
              for (let attempt = 0; attempt < 40 && !failure; attempt++) {
                await wait(25);
                if (geometry() !== beforeGeometry) geometryChanged = true;
                revealed = outermost(hiddenBefore.filter((node) => node.isConnected && !clipped(node)));
                if (Date.now() - activatedAt >= 400 && (revealed.length || !hiddenBefore.length)) break;
              }
              // Let a transition finish before the open state is read.
              let previous = member.outerHTML;
              for (let attempt = 0; attempt < 20 && revealed.length; attempt++) {
                await wait(50);
                if (member.outerHTML === previous) break;
                previous = member.outerHTML;
              }
              observeMutations(observer.takeRecords());
            } finally {
              observer.disconnect();
              clickNavigation?.removeEventListener('navigate', onNavigate);
              browserMethods.forEach((name, index) => {
                const descriptor = originals[index];
                if (descriptor) Object.defineProperty(window, name, descriptor);
                else Reflect.deleteProperty(window, name);
              });
              if (pushDescriptor) Object.defineProperty(history, 'pushState', pushDescriptor);
              else Reflect.deleteProperty(history, 'pushState');
              if (replaceDescriptor) Object.defineProperty(history, 'replaceState', replaceDescriptor);
              else Reflect.deleteProperty(history, 'replaceState');
            }
            if (!failure && !mutated && !browserEffect && !clickNavigationBlocked && !geometryChanged
              && location.href === beforeUrl && history.length === beforeHistoryLength && JSON.stringify(history.state) === beforeHistoryState
              && !member.matches('a,button,input,select,textarea')
              && (member.matches('[data-action],[data-toggle],[data-target]') || getComputedStyle(member).cursor === 'pointer')) {
              inertControls.add(member);
              continue;
            }
            if (failure) break;
            if (clickNavigationBlocked || currentRoute() !== startRoute) { failure = 'activation navigated'; break; }
            if (parent === root && !hiddenBefore.length && !clickNavigationBlocked && currentRoute() === startRoute) {
              // A remainder control with an effect is not an inert claim or a
              // disclosure. Restore local reversible changes using the existing
              // baseline guard, then let later candidates have their own proof.
              await restoreGroup([member], [initial[members.indexOf(member)]!]);
              // A periodic unrelated mutation (for example a clock) makes this
              // window inconclusive, not inert. Reuse this same bounded pass
              // for another full clean window; never ignore that mutation.
              if (mutated && !componentMutated && !browserEffect && !geometryChanged && canonical(member) === initial[members.indexOf(member)]
                && (retries.get(member) ?? 0) < 2) {
                retries.set(member, (retries.get(member) ?? 0) + 1);
                members.splice(memberIndex + 1, 0, member);
                initial.splice(memberIndex + 1, 0, initial[memberIndex]!);
                members.splice(parent === root ? 12_000 : 24);
                initial.splice(parent === root ? 12_000 : 24);
              }
              continue;
            }
            if (foreign.length) { failure = 'activation changed content outside its own item'; break; }
            if (revealed.length !== 1) { failure = revealed.length ? 'activation revealed more than one region' : 'activation revealed nothing'; break; }
            if (opened.some((entry) => clipped(entry.panel))) { failure = 'opening one item closed another'; break; }
            const panelPath = childPath(member, revealed[0]!);
            if (shape(member, panelPath) !== shape(resting[members.indexOf(member)]!, panelPath)) {
              failure = 'activation changed more than presentation'; break;
            }
            opened.push({ member, panel: revealed[0]!, open: presentation(member) });
          }
          // A second activation closes each item and restores its exact markup.
          if (!failure) {
            for (const [index, entry] of opened.entries()) {
              try { entry.member.click(); } catch { failure = 'second activation threw'; break; }
              for (let attempt = 0; attempt < 40 && canonical(entry.member) !== initial[index]; attempt++) await wait(25);
              if (clickNavigationBlocked || currentRoute() !== startRoute) { failure = 'activation navigated'; break; }
              if (canonical(entry.member) !== initial[index] || !clipped(entry.panel)) { failure = 'second activation did not close the item'; break; }
            }
          }
          // A member whose activation navigated (a same-document pushState, a
          // commerce lightbox that opens on `shop/?itemId=…`, for one) leaves the
          // document on another route, and re-clicking members of that group to
          // restore their markup would navigate again. Put the route and history
          // state back with the browser API instead — the same revert the expand
          // toggles and the single-control probe use — and give up on the group:
          // it is recorded as not representable below.
          if (currentRoute() !== startRoute) {
            try {
              history.pushState(startState, '', startRoute);
              window.dispatchEvent(new PopStateEvent('popstate', { state: startState }));
            } catch { /* ignore */ }
            for (let attempt = 0; attempt < 20 && currentRoute() !== startRoute; attempt++) await wait(25);
          } else {
            await restoreGroup(members, initial);
          }
          if (failure) {
            records.push({ status: 'no-dialog', trigger: describeTrigger(members[0]!), target: describe(parent), error: `Click disclosure not representable: ${failure}.` });
            continue;
          }
          for (const entry of opened) {
            const { member, panel } = entry;
            const nodes = [member, ...Array.from(member.querySelectorAll<HTMLElement>('*'))];
            const closed = presentation(member);
            if (tokens(closed[0]!.className) !== tokens(entry.open[0]!.className) || declarations(closed[0]!.style) !== declarations(entry.open[0]!.style)) {
              records.push({ status: 'no-dialog', trigger: describeTrigger(member), target: describe(panel), error: 'Click disclosure not representable: the item restyles itself.' });
              continue;
            }
            const undo = nodes.map((node) => Array.from(node.attributes).map((attribute) => [attribute.name, attribute.value] as const));
            const revert = () => nodes.forEach((node, index) => {
              for (const attribute of Array.from(node.attributes)) node.removeAttribute(attribute.name);
              for (const [name, value] of undo[index]!) node.setAttribute(name, value);
            });
            const swaps: Array<{ node: HTMLElement; name: 'class' | 'style'; open: string; closed: string }> = [];
            nodes.forEach((node, index) => {
              if (index === 0) return;
              const before = closed[index]!, after = entry.open[index]!;
              if (tokens(before.className) !== tokens(after.className)) swaps.push({ node, name: 'class', open: after.className ?? '', closed: before.className ?? '' });
              if (declarations(before.style) !== declarations(after.style)) swaps.push({ node, name: 'style', open: after.style ?? '', closed: before.style ?? '' });
            });
            for (const swap of swaps) {
              swap.node.setAttribute(`data-blocks-engine-capture-disclosure-open-${swap.name}`, swap.open);
              swap.node.setAttribute(`data-blocks-engine-capture-disclosure-closed-${swap.name}`, swap.closed);
            }
            if (!panel.id || document.querySelectorAll(`#${cssEscape(panel.id)}`).length !== 1) {
              let index = 0;
              while (document.getElementById(`data-blocks-engine-capture-disclosure-panel-${index}`)) index++;
              panel.id = `data-blocks-engine-capture-disclosure-panel-${index}`;
            }
            if (!panel.hasAttribute('role')) panel.setAttribute('role', 'region');
            panel.dataset.blocksEngineCaptureLocalDisclosure = 'true';
            panel.dataset.blocksEngineCaptureHydratedDisclosure = 'true';
            member.setAttribute('aria-controls', panel.id);
            member.setAttribute('aria-expanded', 'false');
            if (member.tabIndex < 0 && !member.hasAttribute('tabindex')) member.setAttribute('tabindex', '0');
            // Prove the exported runtime's two states before keeping them.
            const apply = (open: boolean) => {
              panel.hidden = !open;
              for (const swap of swaps) swap.node.setAttribute(swap.name, open ? swap.open : swap.closed);
            };
            apply(true);
            const opens = !clipped(panel);
            apply(false);
            if (!opens || !clipped(panel)) {
              revert();
              records.push({ status: 'no-dialog', trigger: describeTrigger(member), target: describe(panel), error: 'Click disclosure not representable: the normalized panel did not toggle.' });
              continue;
            }
            records.push({ status: 'captured', trigger: describeTrigger(member), target: describe(panel), html: panel.outerHTML });
          }
        }
        // Evidence writes must not contaminate a later control's mutation proof.
        for (const control of inertControls) control.setAttribute('data-blocks-engine-capture-inert-control', 'true');
      } finally {
        clickNavigation?.removeEventListener('navigate', keepClickDocument);
      }
      return records;
    }, { limit: MAX_DISCLOSURE_CANDIDATES, settleMs: MAX_DISCLOSURE_SETTLE_MS, labels: EXPAND_TOGGLE_LABELS, toggleLimit: MAX_EXPAND_TOGGLES, rootSelector, escapeBinding });
    raw = Array.isArray(result) ? (result as RawDisclosureRecord[]) : [];
  } catch (error) {
    throw new Error(`Disclosure baseline restoration unproven: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  return raw.map((record): CapturedDialogInteraction => {
    const bounded = record.html !== undefined ? boundDisclosureHtml(record.html) : undefined;
    return {
      status: record.status,
      kind: 'disclosure',
      trigger: {
        selector: record.trigger.selector,
        tag: record.trigger.tag,
        ...(record.trigger.id ? { id: record.trigger.id } : {}),
        ariaHaspopup: '',
        ...(record.target.id ? { ariaControls: record.target.id } : {}),
        ...(record.trigger.label ? { label: record.trigger.label } : {}),
        dataBindings: {},
      },
      ...(bounded
        ? {
            dialog: {
              selector: record.target.selector,
              tag: record.target.tag,
              ...(record.target.id ? { id: record.target.id } : {}),
              role: 'region',
              ariaModal: false,
              html: bounded.html,
              htmlBytes: bounded.bytes,
              htmlTruncated: bounded.truncated,
            },
          }
        : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  });
}

/**
 * Phase 2 — when a known third-party content widget is on the page, wait until it has
 * actually populated (its container gains child content / text) before we snapshot, so we
 * don't capture an empty placeholder. Polls up to `timeoutMs`; no-op when no known widget
 * is present (so it costs nothing on ordinary pages). Best-effort.
 */
export async function waitForAppWidgets(page: Page, timeoutMs = 8000): Promise<void> {
  try {
    await page.evaluate(
      async ({ sel, timeout }) => {
        const containers = Array.from(document.querySelectorAll(sel));
        if (containers.length === 0) return;
        const populated = (el: Element) =>
          el.childElementCount > 0 || (el.textContent || '').trim().length > 40;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (containers.every(populated)) return;
          await new Promise((r) => setTimeout(r, 250));
        }
      },
      { sel: WIDGET_SELECTOR, timeout: timeoutMs },
    );
  } catch { /* best-effort */ }
}

export interface BodyAssessment {
  /** Text-based emptiness — a fallback signal only. Static HTML can't see that a JS app's
   *  DOM is present-but-renders-blank, so prefer the rendered-height signal (see
   *  `classifyEmptyReason` + readPngHeight) when a screenshot is available. */
  empty: boolean;
  reason: 'ok' | 'iframe' | 'app-widget' | 'thin';
  detail?: string;
  /** Raw signals, exposed so callers can classify the REASON independently of the
   *  (unreliable) text-emptiness threshold. */
  widget: string | null;
  crossOriginIframe: boolean;
  mainTextLen: number;
}

/**
 * Phase 0 — classify a CAPTURED page's body. Pure (operates on the HTML string).
 *
 * IMPORTANT: text length is a weak emptiness signal — a JS app (reviews/FAQ widget)
 * leaves a populated-looking DOM that renders BLANK without its script, and Shopify
 * pages carry ~300 chars of cart/skip-link boilerplate even when "empty". So the
 * `empty` flag here is only a fallback; the reliable emptiness signal is the rendered
 * height (`readPngHeight`, compared to the page-set median). The widget / cross-origin
 * iframe / text-length signals are exposed for the caller to name the REASON.
 */
export function assessBody(html: string, siteOrigin?: string): BodyAssessment {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg').remove();
  const body = $('body'); // cheerio.load always synthesizes a <body>, even for fragments

  const widget = KNOWN_WIDGETS.find((w) => body.find(w.selector).length > 0)?.name ?? null;
  const crossOriginIframe = body
    .find('iframe[src]')
    .toArray()
    .some((el) => {
      const src = $(el).attr('src') || '';
      if (!/^https?:\/\//i.test(src)) return false;
      try {
        return !siteOrigin || new URL(src).origin !== siteOrigin;
      } catch {
        return true;
      }
    });

  const main = body.clone();
  main.find('header, nav, footer, [role="banner"], [role="contentinfo"], [role="navigation"]').remove();
  const mainTextLen = main.text().replace(/\s+/g, ' ').trim().length;

  const EMPTY_THRESHOLD = 200;
  const empty = mainTextLen < EMPTY_THRESHOLD;
  const reason: BodyAssessment['reason'] = crossOriginIframe
    ? 'iframe'
    : widget
      ? 'app-widget'
      : empty
        ? 'thin'
        : 'ok';
  const detail = crossOriginIframe
    ? 'cross-origin <iframe> body'
    : widget
      ? widget
      : `${mainTextLen} chars of body text`;
  return { empty, reason, detail, widget, crossOriginIframe, mainTextLen };
}

/**
 * Read a PNG's pixel height straight from its IHDR (no decode, no deps): the height is a
 * big-endian uint32 at byte offset 20 (8-byte signature + 4 length + "IHDR" = 16, then
 * width@16, height@20). The rendered full-page height is the reliable "is this body
 * empty?" signal — a chrome-only page renders dramatically shorter than a content page.
 * Returns null if the file is missing or not a PNG.
 */
export function readPngHeight(path: string): number | null {
  try {
    const buf = readFileSync(path);
    // 8-byte signature, then the first chunk MUST be IHDR (length@8, type@12). Verify the
    // type bytes too — not just the signature — so a corrupt/non-PNG file can't yield a
    // garbage height that would poison the page-set median in classifyEmptyBodies.
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    const height = buf.readUInt32BE(20);
    // Reject implausible heights (0 / corrupt huge value) rather than skew the median.
    return height > 0 && height <= 200_000 ? height : null;
  } catch {
    return null;
  }
}

export interface PageStat {
  slug: string;
  /** Rendered desktop capture height in px (from `readPngHeight`), or null if unavailable. */
  height: number | null;
  assess: BodyAssessment;
}
export interface EmptyBody {
  slug: string;
  reason: 'iframe' | 'app-widget' | 'short-render' | 'thin';
  detail?: string;
}

/** A page carrying at least this much real body text is never flagged on height alone —
 *  it rescues genuinely-short-but-real pages (long policy copy, an unstyled doc) that
 *  render compact without being empty. Sits well above Shopify's ~300-char cart
 *  boilerplate and well below a real content page. */
const TEXT_RICH_THRESHOLD = 1000;
/** A page rendering shorter than this fraction of the page-set median is "chrome-only". */
const SHORT_RENDER_FRACTION = 0.5;

/**
 * Phase 0 decision over a full page set: which captures came out effectively EMPTY (a
 * JS app that never rendered — reviews/FAQ widgets, cross-origin iframes — leaving just
 * site chrome). The reliable signal is RENDERED HEIGHT: a chrome-only page is dramatically
 * shorter than the page-set median, whereas DOM text is fooled by the app's present-but-
 * blank markup plus ~300 chars of cart boilerplate. A page is flagged when it renders
 * short AND isn't text-rich (the rescue keeps compact-but-real pages). Falls back to the
 * pure-text `assess.empty` signal for any page without a usable screenshot height.
 */
export function classifyEmptyBodies(stats: PageStat[]): EmptyBody[] {
  const heights = stats
    .map((s) => s.height)
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  const out: EmptyBody[] = [];
  for (const s of stats) {
    const shortRender = median > 0 && s.height !== null && s.height < median * SHORT_RENDER_FRACTION;
    const empty =
      s.height !== null ? shortRender && s.assess.mainTextLen < TEXT_RICH_THRESHOLD : s.assess.empty;
    if (!empty) continue;
    const reason: EmptyBody['reason'] = s.assess.crossOriginIframe
      ? 'iframe'
      : s.assess.widget
        ? 'app-widget'
        : s.height !== null
          ? 'short-render'
          : 'thin';
    const detail = s.assess.crossOriginIframe
      ? s.assess.detail
      : s.assess.widget
        ? s.assess.widget
        : s.height !== null
          ? `rendered ${s.height}px vs median ${median}px`
          : s.assess.detail;
    out.push({ slug: s.slug, reason, detail });
  }
  return out;
}
