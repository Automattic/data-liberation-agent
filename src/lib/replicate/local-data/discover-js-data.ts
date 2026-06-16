export type Confidence = 'high' | 'low';

export interface DiscoveredArray {
  name: string;
  records?: Array<Record<string, unknown>>;
  confidence: Confidence;
  evidence: string;
}

export interface DiscoveredMount {
  selector: string;
  wrapperClass?: string;
  sourceCall?: string;
  perPageHint?: number;
  confidence: Confidence;
  evidence: string;
}

export function parseProgram(js: string): any | null {
  void js;
  throw new Error('discover-js-data contract frozen; implementation pending');
}

export function walk(node: any, visit: (n: any) => void): void {
  void node;
  void visit;
  throw new Error('discover-js-data contract frozen; implementation pending');
}

export function discoverDataArrays(js: string): DiscoveredArray[] {
  void js;
  throw new Error('discover-js-data contract frozen; implementation pending');
}

export function discoverMounts(html: string, js: string): DiscoveredMount[] {
  void html;
  void js;
  throw new Error('discover-js-data contract frozen; implementation pending');
}

export function discoverIdLookups(js: string): string[] {
  void js;
  throw new Error('discover-js-data contract frozen; implementation pending');
}
