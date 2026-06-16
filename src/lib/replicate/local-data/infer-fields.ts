import type { DataField } from './types.js';

type Rec = Record<string, unknown>;
export type RoleConfidence = 'high' | 'low';

export interface InferredFields {
  idKey: string;
  titleKey: string;
  contentKey?: string;
  termKey?: string;
  galleryKey?: string;
  fields: DataField[];
  confidence: { id: RoleConfidence; title: RoleConfidence; terms: RoleConfidence };
}

export function inferFields(records: Rec[]): InferredFields {
  void records;
  throw new Error('inferFields contract frozen; implementation pending.');
}
