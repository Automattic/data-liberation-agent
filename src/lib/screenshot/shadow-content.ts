/** Runs in the serializer's browser task, on its existing document clone.
 * Source scripts are stripped by portable export; only registered, static open
 * roots are eligible. Never move live nodes or leak shadow styles into global CSS.
 */
export function portStaticShadowContent(source: Document, snapshot: HTMLElement): () => void {
  // Resolve correspondence before other clone cleanups can remove wrappers.
  const originals = Array.from(source.querySelectorAll('*'));
  const copies = [snapshot, ...snapshot.querySelectorAll('*')];
  const pairs = originals.map((element, index) => [element, copies[index]!] as const);
  const interactive = 'input,select,textarea,button,form,a[href],area[href],iframe,audio,video,details,dialog,[tabindex],[contenteditable]:not([contenteditable="false"]),[role]:not([role="img"]):not([role="presentation"]):not([role="none"])';
  const isStatic = (element: Element): boolean => {
    const definition = customElements.get(element.localName);
    if (element.matches(interactive) || (definition as typeof HTMLElement & { formAssociated?: boolean } | undefined)?.formAssociated) return false;
    if (Array.from(element.attributes).some(attribute => /^on/i.test(attribute.name))) return false;
    return [...element.children, ...(element.shadowRoot?.children ?? [])].every(isStatic);
  };
  // Only shadow-authored declarations need freezing. The surrounding light-DOM
  // cascade remains editable; computed values resolve units and currentColor.
  const declarations = new Map<Element, Set<string>>();
  const collect = (root: ShadowRoot) => {
    const elements = [root.host, ...root.querySelectorAll('*')];
    // A detached selector tree lets native matching cross the :host boundary
    // without moving live nodes or exposing shadow styles to the document.
    const selectorHost = root.host.cloneNode(false) as Element;
    selectorHost.setAttribute('data-shadow-style-host', '');
    selectorHost.append(...Array.from(root.childNodes, node => node.cloneNode(true)));
    const selectorElements = [selectorHost, ...selectorHost.querySelectorAll('*')];
    const hostSelector = (selector: string) => selector.replace(/:host(?:\(([^()]*(?:\([^()]*\)[^()]*)*)\))?(?![\w-])/g, (_match, condition: string | undefined) =>
      !condition || root.host.matches(condition) ? '[data-shadow-style-host]' : ':not(*)');
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText).matches) visit(rule.cssRules);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) visit(rule.cssRules);
        } else if (rule instanceof CSSStyleRule) {
          const hasHost = /:host(?![\w-])/.test(rule.selectorText);
          const selector = hasHost ? hostSelector(rule.selectorText) : rule.selectorText;
          // CSSOM enumerates shorthand declarations as their longhands.
          const expanded = source.createElement('span').style;
          expanded.cssText = rule.style.cssText;
          elements.forEach((element, index) => {
            const matches = hasHost
              ? selectorElements[index]!.matches(selector)
              : element !== root.host && element.matches(selector);
            if (!matches) return;
            const properties = declarations.get(element) ?? new Set<string>();
            for (const property of expanded) properties.add(property);
            declarations.set(element, properties);
          });
        }
      }
    };
    for (const sheet of [...root.styleSheets, ...root.adoptedStyleSheets]) {
      if (!sheet.disabled && (!sheet.media.length || matchMedia(sheet.media.mediaText).matches)) visit(sheet.cssRules);
    }
  };
  const freeze = (element: Element, copy: Element) => {
    if (!(copy instanceof HTMLElement || copy instanceof SVGElement)) return;
    const computed = getComputedStyle(element);
    for (const property of declarations.get(element) ?? []) copy.style.setProperty(property, computed.getPropertyValue(property));
  };
  const renderedCopy = (node: Node): Node[] => {
    if (!(node instanceof Element)) return [node.cloneNode(true)];
    if (node.matches('style,link[rel="stylesheet"],script')) return [];
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      return (assigned.length ? assigned : Array.from(node.childNodes)).flatMap(renderedCopy);
    }
    const copy = node.cloneNode(false) as Element;
    if (node.shadowRoot) collect(node.shadowRoot);
    freeze(node, copy);
    const children = node.shadowRoot?.childNodes ?? node.childNodes;
    copy.append(...Array.from(children).flatMap(renderedCopy));
    return [copy];
  };
  return () => {
    for (const [element, copy] of pairs) {
      if (!snapshot.contains(copy) || !element.shadowRoot) continue;
      // Unregistered/declarative hosts and controls retain their existing
      // contract. The export carries no source custom-element definitions.
      if (!customElements.get(element.localName) || !isStatic(element)) continue;
      collect(element.shadowRoot);
      freeze(element, copy);
      copy.replaceChildren(...Array.from(element.shadowRoot.childNodes).flatMap(renderedCopy));
    }
  };
}
