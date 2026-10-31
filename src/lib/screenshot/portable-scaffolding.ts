import type { ProfileDiagnostic } from './manifest-queue.js';

/** Runs synchronously in the browser. Mutations are confined to the snapshot;
 * trial unwrapping is restored before the source runtime can run another task. */
export function cleanPortableScaffolding(source: Document, snapshot: HTMLElement): ProfileDiagnostic[] {
  const findings: ProfileDiagnostic[] = [];
  const originals = Array.from(source.documentElement.querySelectorAll('*'));
  const copies = Array.from(snapshot.querySelectorAll('*'));
  const copyOf = new Map(originals.map((node, index) => [node, copies[index]!]));
  const report = (code: string, node: Element, reason: string) => findings.push({ code, reason: `${node.localName}${node.id ? `#${node.id}` : ''}: ${reason}` });
  for (const node of originals) {
    const copy = copyOf.get(node)!;
    const dismissal = node.getAttribute('data-lib-dismissed-overlay');
    copy.removeAttribute('data-lib-dismissed-overlay');
    if (dismissal) {
      const evidence = JSON.parse(dismissal) as { kind: string; method: string; selector: string; removable?: boolean };
      // A genuine takeover may contain authored promotional content. Keep it
      // available to the dialog/component path, rather than deleting its prose.
      if (evidence.removable || evidence.kind !== 'takeover') {
        copy.remove();
        report('dismissed_overlay_removed', node, `${evidence.kind} dismissed by ${evidence.method} (${evidence.selector})`);
      }
    }
    if (node instanceof HTMLAnchorElement && node.getAttribute('href')?.startsWith('#')) {
      const fragment = node.getAttribute('href')!.slice(1);
      let target: Element | null = null;
      try { target = source.getElementById(decodeURIComponent(fragment)); } catch { /* malformed fragment has no target */ }
      if (!target && !Array.from(source.getElementsByName(fragment)).some(element => element !== node)) {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const hidden = rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.clip !== 'auto' || style.clipPath !== 'none';
        if (hidden) {
          copy.remove();
          report('hidden_navigation_affordance_removed', node, 'hidden in-page link without a content target');
        }
      }
    }
  }
  // App roots are structural candidates, not a framework removal list. A
  // landmark, anchor target, authored state or box styling is never disposable.
  const roots = originals.filter(node => node.localName === 'div' && /^(?:__next|root|app|app-root)$/i.test(node.id)).slice(0, 16);
  const unwrapped: Array<{ node: Element; parent: Node; next: Node | null; children: Node[] }> = [];
  try {
  for (const node of roots.reverse()) {
    const copy = copyOf.get(node)!;
    if (!snapshot.contains(copy) || node.hasAttribute('role') || node.children.length !== 1 || Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) continue;
    if (originals.some(other => other.getAttribute('href') === `#${node.id}` || other.getAttribute('aria-controls')?.split(/\s+/).includes(node.id))) continue;
    const style = getComputedStyle(node);
    if (!['block', 'contents'].includes(style.display) || style.position !== 'static' || style.transform !== 'none' || style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none' || style.opacity !== '1' || style.overflow !== 'visible') continue;
    if (['::before', '::after'].some(pseudo => !['none', 'normal'].includes(getComputedStyle(node, pseudo).content))) continue;
    if (['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(property => parseFloat(style[property as keyof CSSStyleDeclaration] as string) !== 0)) continue;
    // Prove selector, inherited style and geometry equivalence, not just a
    // same-size box. This also protects sibling combinators and root selectors.
    const observed = originals.filter(element => element !== node && element.isConnected);
    if (observed.length > 2000) continue;
    const signature = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      return JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height, ...Array.from(computed, property => computed.getPropertyValue(property)), ...['::before', '::after'].map(pseudo => {
        const css = getComputedStyle(element, pseudo);
        return Array.from(css, property => css.getPropertyValue(property)).join(';');
      })]);
    };
    const before = observed.map(signature);
    const parent = node.parentNode!;
    const next = node.nextSibling;
    const children = Array.from(node.childNodes);
    let equivalent = false;
    try {
      node.replaceWith(...children);
      equivalent = observed.every((element, index) => signature(element) === before[index]);
    } finally {
      if (!equivalent) {
        parent.insertBefore(node, next);
        node.append(...children);
      } else {
        // Keep accepted trials in effect until all decisions are made, so two
        // individually redundant ancestor selectors cannot both be discarded.
        unwrapped.push({ node, parent, next, children });
      }
    }
    if (equivalent) {
      copy.replaceWith(...Array.from(copy.childNodes));
      report('app_root_unwrapped', node, 'no box, selector, inherited style or geometry contribution');
    }
  }
  } finally {
    for (const { node, parent, next, children } of unwrapped.reverse()) {
      parent.insertBefore(node, next);
      node.append(...children);
    }
  }
  return findings;
}
