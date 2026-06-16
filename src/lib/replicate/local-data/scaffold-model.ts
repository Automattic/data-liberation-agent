import type { ScaffoldResult } from './scaffold-types.js';

export interface ScaffoldInput {
  html: string;
  js: string;
  skippedFiles?: string[];
}

export function scaffoldDataModel(input: ScaffoldInput): ScaffoldResult {
  void input;
  throw new Error('scaffoldDataModel contract frozen; implementation pending.');
}
