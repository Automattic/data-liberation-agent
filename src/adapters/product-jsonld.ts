/** Provider-neutral primitives for bounded, inert product JSON-LD completion. */
export type JsonLdNode = Record<string, any>;
export function object(value: unknown): value is JsonLdNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function list(value: unknown): any[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
export function withinJsonLdLimits(scripts: string[]): boolean {
  return scripts.length <= 16 && scripts.every(source => Buffer.byteLength(source) <= 64 * 1024) &&
    scripts.reduce((sum, source) => sum + Buffer.byteLength(source), 0) <= 256 * 1024;
}
/** Explicit identities must describe this origin and route, not a related product. */
export function describesPage(node: JsonLdNode, pageUrl: string): boolean {
  const page = new URL(pageUrl);
  const sources = [node.url, node['@id'], ...list(node.offers).map(offer => offer?.url)]
    .filter((value): value is string => typeof value === 'string' && !value.startsWith('#'));
  if (!sources.length) return true;
  return sources.some(source => {
    try {
      const url = new URL(source, pageUrl);
      return url.origin === page.origin && url.pathname.replace(/\/$/, '') === page.pathname.replace(/\/$/, '');
    } catch { return false; }
  });
}
