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
  // Use the same computed-value -> inline declaration contract as other frozen
  // rendering. Resolving the cascade also handles :host, inherited colour,
  // adopted stylesheets and active media rules without rewriting CSS selectors.
  const freeze = (element: Element, copy: Element) => {
    if (!(copy instanceof HTMLElement || copy instanceof SVGElement)) return;
    const computed = getComputedStyle(element);
    for (const property of computed) copy.style.setProperty(property, computed.getPropertyValue(property));
  };
  const renderedCopy = (node: Node): Node[] => {
    if (!(node instanceof Element)) return [node.cloneNode(true)];
    if (node.matches('style,link[rel="stylesheet"],script')) return [];
    if (node instanceof HTMLSlotElement) {
      const assigned = node.assignedNodes({ flatten: true });
      return (assigned.length ? assigned : Array.from(node.childNodes)).flatMap(renderedCopy);
    }
    const copy = node.cloneNode(false) as Element;
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
      freeze(element, copy);
      copy.replaceChildren(...Array.from(element.shadowRoot.childNodes).flatMap(renderedCopy));
    }
  };
}
