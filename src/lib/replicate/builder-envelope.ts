// src/lib/replicate/builder-envelope.ts
// Validates the structured JSON envelope a builder subagent returns. A
// malformed/partial return must be a LOUD failure (→ retry/sequential), never a
// silent corruption of the assembled theme.
export interface BuilderPattern { slug: string; php: string; }
export interface BuilderEnvelope { patterns: BuilderPattern[]; sitewideFlags: string[]; notes: string[]; }
export interface EnvelopeParseResult { ok: boolean; envelope?: BuilderEnvelope; errors: string[]; }

export function parseBuilderEnvelope(raw: unknown): EnvelopeParseResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['envelope must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.patterns)) {
    errors.push('envelope.patterns must be an array');
  } else {
    obj.patterns.forEach((p, i) => {
      const pat = p as Record<string, unknown>;
      if (typeof pat?.slug !== 'string') errors.push(`patterns[${i}].slug must be a string`);
      if (typeof pat?.php !== 'string') errors.push(`patterns[${i}].php must be a string`);
    });
  }
  if (obj.sitewideFlags !== undefined && !Array.isArray(obj.sitewideFlags)) {
    errors.push('envelope.sitewideFlags must be an array when present');
  }
  if (obj.notes !== undefined && !Array.isArray(obj.notes)) {
    errors.push('envelope.notes must be an array when present');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    envelope: {
      patterns: (obj.patterns as BuilderPattern[]),
      sitewideFlags: (obj.sitewideFlags as string[]) ?? [],
      notes: (obj.notes as string[]) ?? [],
    },
  };
}
