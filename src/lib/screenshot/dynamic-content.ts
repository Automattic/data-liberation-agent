import { readFileSync } from 'node:fs';
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
 * Phase 1 — expand statically-collapsed content so the screenshot captures it. Opens
 * `<details>`, expands disclosure panels (`[aria-expanded="false"][aria-controls]`),
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
      const safeToActivate = (element: Element) => {
        if (element.hasAttribute('aria-haspopup')) return false;
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

      document.querySelectorAll('details:not([open])').forEach((d) => {
        // A details whose panel is a dialog is an interactive disclosure, not
        // collapsed page content: force-opening it overlays the document with
        // a fixed panel and flips the very toggle a later interactivity probe
        // measures, so a working menu reports as dead.
        if (d.querySelector('[role="dialog"],[aria-modal="true"]')) return;
        (d as HTMLDetailsElement).open = true;
      });

      let navigated = false;
      const openedPopulated: HTMLElement[] = [];
      for (const el of Array.from(document.querySelectorAll('[aria-expanded="false"][aria-controls]'))) {
        if (navigated) break;
        if (!safeToActivate(el) || isExpandToggle(el)) continue;
        const controlledId = el.getAttribute('aria-controls') || '';
        const localPanel = el.parentElement && Array.from(el.parentElement.querySelectorAll('[id]')).find((node) => node.id === controlledId);
        const alreadyPopulated = Boolean(localPanel
          && localPanel.getAttribute('role') === 'region'
          && ((localPanel.textContent || '').trim() || localPanel.querySelector('img,video,audio,picture,svg,canvas')));
        if ((await activate(el)) === 'navigated') navigated = true;
        else if (alreadyPopulated && el instanceof HTMLElement) openedPopulated.push(el);
      }
      if (!navigated) {
        for (const el of openedPopulated) {
          if (el.getAttribute('aria-expanded') !== 'true') continue;
          let scope = el.parentElement;
          while (scope && scope !== document.body && openedPopulated.filter((item) => scope!.contains(item)).length < 2) scope = scope.parentElement;
          const openedHere = scope ? openedPopulated.filter((item) => scope!.contains(item)) : [];
          const stillOpen = openedHere.filter((item) => item.getAttribute('aria-expanded') === 'true');
          if (openedHere.length >= 2 && stillOpen.length === 1) await activate(el);
        }
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

const MAX_DISCLOSURE_CANDIDATES = 32;
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
 * Runs after the visual reference so hydration cannot change screenshot
 * geometry, and BEFORE `page.content()` is serialized, so the captured static
 * HTML contains the restored panels directly (no post-hoc wiring needed).
 *
 * The same candidate pass also includes visible "show more" / "read more"
 * toggles. Those are not left open by `expandCollapsedContent`: the opened
 * form is recorded here and the collapsed label is put back. A second click
 * is the restore; a one-way handler is put back from the pre-click snapshot.
 *
 * Returns per-candidate diagnostics folded into `interaction-states.json`
 * alongside dialog/menu captures (`kind: 'disclosure'`) so this work is
 * observable with the same `candidate_count`/`captured_count` conventions.
 */
export async function hydrateDisclosureContent(page: Page, rootSelector = 'body'): Promise<CapturedDialogInteraction[]> {
  let raw: RawDisclosureRecord[];
  try {
    const result = await page.evaluate(async ({ limit, settleMs, labels, toggleLimit, rootSelector }: { limit: number; settleMs: number; labels: string[]; toggleLimit: number; rootSelector: string }) => {
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
        if (element.hasAttribute('aria-haspopup')) return false;
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
            if (target && target.getAttribute('role') === 'region' && !seen.has(trigger)) {
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
            !trigger.hasAttribute('aria-haspopup')
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
            const copy = panel?.cloneNode(true) as HTMLElement | undefined;
            const openIcons = Array.from(trigger.querySelectorAll('svg')).map(icon => ({className: icon.getAttribute('class') ?? '', style: icon.getAttribute('style') ?? ''}));
            if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
            const deadline = Date.now() + settleMs;
            while (Date.now() < deadline && (trigger.getAttribute('aria-expanded') !== 'false' || panel?.isConnected)) await wait(25);
            if (copy && trigger.getAttribute('aria-expanded') === 'false' && !panel?.isConnected) {
              const icons = Array.from(trigger.querySelectorAll('svg'));
              if (icons.length === closedIcons.length && icons.length === openIcons.length) icons.forEach((icon,index) => {
                const closed = closedIcons[index]!, open = openIcons[index]!;
                if ((icon.getAttribute('class') ?? '') !== closed.className || (icon.getAttribute('style') ?? '') !== closed.style) return;
                if (closed.className !== open.className) {
                  icon.setAttribute('data-dla-disclosure-open-class',open.className);
                  icon.setAttribute('data-dla-disclosure-closed-class',closed.className);
                }
                if (closed.style !== open.style) {
                  icon.setAttribute('data-dla-disclosure-open-style',open.style);
                  icon.setAttribute('data-dla-disclosure-closed-style',closed.style);
                }
              });
              mountedPanels.push({ trigger, parent: target, panel: copy });
              hydrated++;
            } else {
              records.push({ status: 'no-dialog', trigger: describeTrigger(trigger), target: describe(target), error: 'No unique locally mounted panel with verified collapsed restoration.' });
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
          target.dataset.dlaHydratedDisclosure = 'true';
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
        while (document.getElementById(`dla-disclosure-panel-${index}`)) index++;
        panel.id = `dla-disclosure-panel-${index}`;
        panel.hidden = true;
        panel.setAttribute('role', 'region');
        panel.dataset.dlaHydratedDisclosure = 'true';
        panel.dataset.dlaLocalDisclosure = 'true';
        const group = parent.parentElement;
        if (group && exclusiveGroups.has(group)) group.dataset.dlaExclusiveDisclosures = 'true';
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
        const overflow = style.overflowY || style.overflow;
        return {
          display: style.display,
          opacity: style.opacity,
          heightZero: node.getBoundingClientRect().height < 1 && (overflow === 'hidden' || overflow === 'clip'),
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
        if (!panel || panel.getAttribute('role') !== 'region' || !hasContent(panel) || !trigger.parentElement?.contains(panel)) continue;
        if (panel.dataset.dlaLocalDisclosure || panel.dataset.dlaHydratedDisclosure) continue;
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
        text: panel.textContent,
        controls: trigger.getAttribute('aria-controls') || '',
        nodes: concealmentNodes(panel, trigger).map((node) => ({ style: node.getAttribute('style'), className: node.getAttribute('class') })),
      });
      const resolveLive = (entry: { trigger: HTMLElement; panel: HTMLElement; snap: ReturnType<typeof snapshotOf> }) => {
        const controls = entry.snap.controls;
        const triggers = Array.from(root.querySelectorAll<HTMLElement>('[aria-controls]')).filter((trigger) => trigger.isConnected && trigger.getAttribute('aria-controls') === controls);
        const trigger = (entry.trigger.isConnected ? entry.trigger : undefined) || triggers.find((item) => visible(item)) || triggers[0];
        const panel = trigger ? panelForTrigger(trigger) : null;
        return { trigger: trigger || entry.trigger, panel: panel || entry.panel };
      };
      const applySnap = (trigger: HTMLElement, panel: HTMLElement, snap: ReturnType<typeof snapshotOf>) => {
        if (!trigger.isConnected || !panel.isConnected) return;
        trigger.setAttribute('aria-expanded', snap.expanded ? 'true' : 'false');
        if (snap.hidden) panel.setAttribute('hidden', '');
        else panel.removeAttribute('hidden');
        if (snap.ariaHidden === null) panel.removeAttribute('aria-hidden');
        else panel.setAttribute('aria-hidden', snap.ariaHidden);
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
          const style = node.getAttribute('style') || '';
          const computed = getComputedStyle(node);
          if ((closed && opened && closed.display === 'none' && opened.display !== 'none') || computed.display === 'none' || node.style.display === 'none') {
            if (opened?.inlineDisplay && opened.display !== 'none') node.style.display = opened.inlineDisplay;
            else node.style.removeProperty('display');
          }
          if ((closed && opened && closed.opacity === '0' && opened.opacity !== '0') || computed.opacity === '0' || node.style.opacity === '0') {
            if (opened?.inlineOpacity && opened.opacity !== '0') node.style.opacity = opened.inlineOpacity;
            else node.style.removeProperty('opacity');
          }
          const inlineConceals = /(?:^|;)\s*height\s*:\s*0(?:px)?\s*(?:;|$)/i.test(style) || computed.overflow === 'hidden' || computed.overflowY === 'hidden';
          if ((closed?.heightZero && !opened?.heightZero) || (inlineConceals && node.getBoundingClientRect().height < 1 && node !== entry.panel)) {
            node.style.height = 'auto';
            node.style.overflow = 'visible';
          }
          if (closed && opened) {
            const closedTokens = closed.className.split(/\s+/).filter(Boolean);
            const openTokens = opened.className.split(/\s+/).filter(Boolean);
            for (const token of closedTokens) if (!openTokens.includes(token)) node.classList.remove(token);
            for (const token of openTokens) if (!closedTokens.includes(token)) node.classList.add(token);
          }
        });
        entry.trigger.setAttribute('aria-expanded', entry.snap.expanded ? 'true' : 'false');
        entry.panel.hidden = !entry.snap.expanded;
        if (entry.snap.ariaHidden !== null) entry.panel.setAttribute('aria-hidden', entry.snap.expanded ? 'false' : 'true');
        entry.panel.dataset.dlaLocalDisclosure = 'true';
        entry.panel.dataset.dlaHydratedDisclosure = 'true';
        const cluster = clusterOf(entry.trigger);
        if (cluster && exclusiveClusters.has(cluster)) cluster.dataset.dlaExclusiveDisclosures = 'true';
      };
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
      return records;
    }, { limit: MAX_DISCLOSURE_CANDIDATES, settleMs: MAX_DISCLOSURE_SETTLE_MS, labels: EXPAND_TOGGLE_LABELS, toggleLimit: MAX_EXPAND_TOGGLES, rootSelector });
    raw = Array.isArray(result) ? (result as RawDisclosureRecord[]) : [];
  } catch {
    raw = [];
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
