import type { ProfileDiagnostic } from './manifest-queue.js';

export interface PortableScaffoldingOptions {
  /** Prove and unwrap inert wrappers (default true). A later re-serialization whose structure is discarded skips it. */
  unwrap?: boolean;
  /** Identity stamp that may sit on a wrapper; unwrapped stamps are returned. */
  nodeIdAttribute?: string;
  /** Proof work for one serialization, in element signatures plus conditional selector queries. Deterministic, unlike a clock. */
  workBudget?: number;
  /** Pages with more observed elements than this are not proven at all. */
  maxElements?: number;
}

export interface PortableScaffoldingResult {
  findings: ProfileDiagnostic[];
  /** Identity stamps of the wrappers removed from the snapshot. */
  unwrapped: string[];
}

/** Runs synchronously in the browser. Mutations are confined to the snapshot;
 * trial unwrapping is restored before the source runtime can run another task. */
export function cleanPortableScaffolding(source: Document, snapshot: HTMLElement, options: PortableScaffoldingOptions = {}): PortableScaffoldingResult {
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
    // A targetless `#` link with control semantics is a script-owned control
    // (a menu toggle, for example) that width-dependent CSS may hide only at
    // this capture width; it is not a disposable in-page navigation affordance.
    // Only a top-of-document link (`#`, `#top`) is a disposable affordance. A
    // named fragment without a target is rendered content (a script-rendered
    // product name linking to an SPA route hash, for example): it stays, and
    // export reports it as an unresolved anchor (#1984).
    const topFragment = node instanceof HTMLAnchorElement && /^#(?:top)?$/i.test(node.getAttribute('href')?.trim() ?? '');
    if (topFragment && node.getAttribute('role')?.trim().toLowerCase() !== 'button'
      && !['aria-haspopup', 'aria-expanded', 'aria-controls'].some(name => node.hasAttribute(name))) {
      const fragment = node.getAttribute('href')!.trim().slice(1);
      if (!fragment || (!source.getElementById(fragment) && !Array.from(source.getElementsByName(fragment)).some(element => element !== node))) {
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
  const unwrappedIds: string[] = [];
  const body = source.body;
  if (options.unwrap === false || !body) return { findings, unwrapped: unwrappedIds };

  // Inert wrappers: a div/span that adds no box, selector, inherited style or
  // geometry. Candidates are structural; each removal is proven against the
  // whole page's computed style and geometry before it is kept (#2042).
  const nodeIdAttribute = options.nodeIdAttribute ?? 'data-blocks-engine-node-id';
  const workBudget = options.workBudget ?? 60_000;
  const maxElements = options.maxElements ?? 5000;
  let work = 0;
  const depthOf = (root: Element) => {
    let max = 0;
    const pending: Array<[Element, number]> = [[root, 0]];
    for (let item = pending.pop(); item; item = pending.pop()) {
      if (item[1] > max) max = item[1];
      for (const child of Array.from(item[0].children)) pending.push([child, item[1] + 1]);
    }
    return max;
  };
  const elementsBefore = snapshot.querySelectorAll('*').length + 1;
  const depthBefore = depthOf(snapshot);
  const html = 'http://www.w3.org/1999/xhtml';
  const appRoot = (node: Element) => node.localName === 'div' && /^(?:__next|root|app|app-root)$/i.test(node.id);
  const appRoots = new Set(originals.filter(appRoot).slice(0, 16));

  // Capture evidence (interaction, collection, gallery and scroll probes) names
  // elements by live-DOM paths, recorded after this snapshot. Unwrapping a child
  // of an element on such a path would re-index it, so wrappers stay wherever a
  // probed control, landmark or hidden (state-owned) element lives in the parent.
  const probed = 'a[href],area[href],button,input,select,textarea,details,summary,dialog,form,label,iframe,video,audio,canvas,object,embed,header,nav,footer,[role],[tabindex],[aria-controls],[aria-expanded],[aria-haspopup],[onclick],[contenteditable]';
  const anchors = new Set<Element>();
  const anchored = new Set<Element>();
  for (const element of Array.from(body.querySelectorAll('*'))) {
    if (/^(?:script|style|template|noscript|link|meta)$/.test(element.localName)) continue;
    let anchor = element.matches(probed);
    if (!anchor) {
      const style = getComputedStyle(element);
      anchor = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    }
    if (!anchor) continue;
    anchors.add(element);
    for (let parent = element.parentElement; parent && !anchored.has(parent); parent = parent.parentElement) anchored.add(parent);
  }
  const evidenceProtected = (node: Element) => {
    if (anchored.has(node.parentElement!)) return true;
    for (let current: Element | null = node; current; current = current.parentElement) if (anchors.has(current)) return true;
    return false;
  };

  // Rules the capture width does not exercise: inactive media and container
  // conditions, and interaction pseudo-classes. Whatever the signature cannot
  // observe here must not depend on a candidate at all.
  const harmless = /^(?:transition|animation|will-change|-webkit-tap-highlight-color|box-sizing|touch-action|scroll-)/;
  const dynamicPseudo = /:(?:hover|focus-within|focus-visible|focus|active|visited|target-within|target|checked|indeterminate|placeholder-shown|autofill|-webkit-autofill|popover-open|open|modal|playing|paused|user-invalid|user-valid)(?![\w-])/g;
  const pseudoElement = /::?(?:before|after|first-line|first-letter|marker|placeholder|selection|backdrop|file-selector-button|cue|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?|::(?:part|slotted)\([^)]*\)/g;
  const conditional = new Map<string, boolean>();
  const visit = (rules: CSSRuleList, inactive: boolean, depth: number) => {
    if (depth > 8) return;
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const text = rule.selectorText;
        const dynamic = text.replace(dynamicPseudo, ':where(*)');
        if (!inactive && dynamic === text) continue;
        if (!Array.from(rule.style).some(property => !harmless.test(property))) continue;
        const selector = dynamic.replace(pseudoElement, '').trim() || '*';
        conditional.set(selector, /[\s>+~]|:(?:nth-|first-|last-|only-|empty|has\(|not\(|is\(|where\()/.test(selector));
      } else if (rule instanceof CSSMediaRule) {
        const queries = rule.media.mediaText.split(',');
        if (queries.every(query => /^\s*(?:only\s+)?(?:print|speech)\b/i.test(query))) continue;
        visit(rule.cssRules, inactive || !matchMedia(rule.media.mediaText).matches, depth + 1);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) visit(rule.cssRules, inactive, depth + 1);
      } else if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) visit(rule.styleSheet.cssRules, inactive || (rule.media.mediaText !== '' && !matchMedia(rule.media.mediaText).matches), depth + 1);
        } catch { /* cross-origin import: its active rules are still in the signature */ }
      } else if ('cssRules' in rule && rule.cssRules) {
        // @container conditions vary with width; @layer/@scope/@starting-style keep their context.
        visit(rule.cssRules as CSSRuleList, inactive || rule.constructor.name === 'CSSContainerRule', depth + 1);
      }
    }
  };
  for (const sheet of Array.from(source.styleSheets)) {
    if (sheet.disabled) continue;
    try {
      visit(sheet.cssRules, sheet.media.mediaText !== '' && !matchMedia(sheet.media.mediaText).matches, 0);
    } catch { /* cross-origin sheet: its active rules are still in the signature */ }
  }
  const conditionallyMatched = new Set<Element>();
  const structural: Array<{ selector: string; matches: Element[] }> = [];
  for (const [selector, isStructural] of conditional) {
    let matches: Element[];
    try {
      matches = Array.from(source.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const element of matches) conditionallyMatched.add(element);
    if (isStructural) structural.push({ selector, matches });
  }

  const zeroBox = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
  const neutralAttribute = (name: string) => name === 'class' || name === nodeIdAttribute
    || (name.startsWith('data-') && !/^data-(?:lib|blocks-engine)/.test(name) && !/(?:state|active|open|selected|expanded|checked|current|visible|hidden|index)/.test(name));
  let protectedCount = 0;
  const candidates: Array<{ node: Element; depth: number }> = [];
  for (const node of originals) {
    const root = appRoots.has(node);
    if (!root && !(node.namespaceURI === html && (node.localName === 'div' || node.localName === 'span'))) continue;
    if (node === body || !body.contains(node) || !snapshot.contains(copyOf.get(node)!) || node.children.length === 0) continue;
    if (Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) continue;
    if (node.hasAttribute('role')) continue;
    if (root) {
      // App roots are framework mounts with an authored id: keep them when anything targets it.
      if (originals.some(other => other.getAttribute('href') === `#${node.id}` || other.getAttribute('aria-controls')?.split(/\s+/).includes(node.id))) continue;
    } else {
      if (!node.getAttributeNames().every(name => neutralAttribute(name) || (name === 'style' && Array.from((node as HTMLElement).style).every(property => property === 'display')))) continue;
    }
    const style = getComputedStyle(node);
    const parentDisplay = getComputedStyle(node.parentElement!).display;
    const display = style.display === 'contents' || (style.display === 'block' && (root || /^(?:block|flow-root|list-item)$/.test(parentDisplay)))
      || (!root && style.display === 'inline' && !/flex|grid/.test(parentDisplay) && Array.from(node.children).every(child => /^inline/.test(getComputedStyle(child).display)));
    if (!display || style.position !== 'static' || style.transform !== 'none' || style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none' || style.opacity !== '1' || style.overflow !== 'visible') continue;
    if (style.filter !== 'none' || style.clipPath !== 'none' || style.mixBlendMode !== 'normal' || style.isolation !== 'auto' || style.visibility !== 'visible' || style.outlineStyle !== 'none' || style.maskImage !== 'none') continue;
    if (['::before', '::after'].some(pseudo => !['none', 'normal'].includes(getComputedStyle(node, pseudo).content))) continue;
    if (zeroBox.some(property => parseFloat(style[property as keyof CSSStyleDeclaration] as string) !== 0)) continue;
    if (conditionallyMatched.has(node)) continue;
    if (!root && evidenceProtected(node)) { protectedCount++; continue; }
    let depth = 0;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) depth++;
    candidates.push({ node, depth });
  }
  // Deepest first: an inner wrapper's proof never depends on an outer one still being present.
  candidates.sort((a, b) => b.depth - a.depth);

  const observed = [source.documentElement, body, ...Array.from(body.querySelectorAll('*'))];
  const accepted: Element[] = [];
  const stack: Array<{ node: Element; parent: Node; next: Node | null; children: Node[] }> = [];
  let rejected = 0;
  let unproven = 0;
  let exhausted: string | undefined;
  try {
    if (candidates.length && observed.length > maxElements) {
      exhausted = `${observed.length} elements exceed the ${maxElements}-element proof budget`;
      unproven = candidates.length;
    } else if (candidates.length) {
      // Prove selector, inherited style and geometry equivalence, not just a
      // same-size box. This also protects sibling and child combinators,
      // structural pseudo-classes and root selectors.
      const signature = (element: Element) => {
        work++;
        const bounds = element.getBoundingClientRect();
        const computed = getComputedStyle(element);
        let text = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
        for (let index = 0; index < computed.length; index++) text += ';' + computed.getPropertyValue(computed[index]!);
        for (const pseudo of ['::before', '::after']) {
          const css = getComputedStyle(element, pseudo);
          text += '|' + css.content;
          if (css.content === 'none' || css.content === 'normal') continue;
          for (let index = 0; index < css.length; index++) text += ';' + css.getPropertyValue(css[index]!);
        }
        return text;
      };
      const baseline = new Map(observed.map(element => [element, signature(element)]));
      const equivalent = () => {
        for (const { selector, matches } of structural) {
          work++;
          const now = source.querySelectorAll(selector);
          if (now.length !== matches.length || matches.some((element, index) => now[index] !== element)) return false;
        }
        return observed.every(element => !element.isConnected || signature(element) === baseline.get(element));
      };
      const attempt = (batch: Element[]): void => {
        if (exhausted || work > workBudget) {
          exhausted ??= `proof budget of ${workBudget} signatures spent`;
          unproven += batch.length;
          return;
        }
        const trial: typeof stack = [];
        let ok = false;
        try {
          for (const node of batch) {
            const entry = { node, parent: node.parentNode!, next: node.nextSibling, children: Array.from(node.childNodes) };
            node.replaceWith(...entry.children);
            trial.push(entry);
          }
          ok = equivalent();
        } finally {
          if (!ok) {
            for (const { node, parent, next, children } of trial.reverse()) {
              parent.insertBefore(node, next);
              node.append(...children);
            }
          }
        }
        if (ok) {
          // Keep accepted trials in effect until all decisions are made, so two
          // individually redundant ancestor selectors cannot both be discarded.
          stack.push(...trial);
          accepted.push(...batch);
        } else if (batch.length === 1) rejected++;
        else {
          const half = Math.ceil(batch.length / 2);
          attempt(batch.slice(0, half));
          attempt(batch.slice(half));
        }
      };
      for (let index = 0; index < candidates.length; index += 32) attempt(candidates.slice(index, index + 32).map(candidate => candidate.node));
    }
  } finally {
    for (const { node, parent, next, children } of stack.reverse()) {
      parent.insertBefore(node, next);
      node.append(...children);
    }
  }
  for (const node of accepted) {
    const copy = copyOf.get(node)!;
    copy.replaceWith(...Array.from(copy.childNodes));
    const id = node.getAttribute(nodeIdAttribute);
    if (id) unwrappedIds.push(id);
    if (appRoots.has(node)) report('app_root_unwrapped', node, 'no box, selector, inherited style or geometry contribution');
  }
  // Reported only when the page had wrappers to consider, so a page without
  // any keeps a clean profile.
  if (candidates.length || protectedCount) findings.push({
    code: 'inert_wrappers_unwrapped',
    reason: `${elementsBefore} elements, ${candidates.length} candidates, ${accepted.length} unwrapped, ${rejected} kept by proof, ${protectedCount} kept for capture evidence, ${unproven} unproven; max depth ${depthBefore} -> ${depthOf(snapshot)}`,
  });
  if (exhausted) findings.push({ code: 'inert_wrapper_budget_exhausted', reason: `${unproven} candidate wrapper(s) kept unproven: ${exhausted}` });
  return { findings, unwrapped: unwrappedIds };
}
