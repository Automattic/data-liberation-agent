//
// page-template-plan.ts
// =====================
// PURE template-collapse logic for the blocks reconstruct path. A page's TEMPLATE
// is a function of two booleans only — overlayHeader (transparent header over a
// flush cover hero) and fullWidth (a non-chrome full-bleed section) — so N pages
// need at most 4 distinct templates, not N. This module computes the variant,
// plans the deduped named templates + per-page assignments, reconciles stale
// files, and merges theme.json customTemplates. The key is shaped so a future
// chrome-signature axis can extend it without reworking callers.
//
import type { SectionSpec } from './section-extract.js';

export type VariantKey = 'standard' | 'full' | 'overlay' | 'overlay-full';

export interface TemplateVariant {
  overlayHeader: boolean;
  fullWidth: boolean;
  key: VariantKey;
}

const SOURCE_HEADER_ABOVE_PX = 40;

/** Derive the page-template variant. `heroIsCover` comes from the reconstruction
 *  result (NOT the specs), so it must be passed in. Mirrors the original inline
 *  logic at reconstruct-pages.ts:188-206. */
export function computeTemplateVariant(sections: SectionSpec[], heroIsCover: boolean): TemplateVariant {
  const fullWidth = sections.some(
    (s) => s.fullBleed && s.interactionModel !== 'footer' && s.interactionModel !== 'nav',
  );
  const bodyForHeader = sections.filter(
    (s) => s.interactionModel !== 'footer' && s.interactionModel !== 'nav',
  );
  const heroTop = bodyForHeader.length ? bodyForHeader[0].top ?? 0 : 0;
  const overlayHeader = heroIsCover && heroTop < SOURCE_HEADER_ABOVE_PX;
  return { overlayHeader, fullWidth, key: variantKey(overlayHeader, fullWidth) };
}

function variantKey(overlayHeader: boolean, fullWidth: boolean): VariantKey {
  if (overlayHeader && fullWidth) return 'overlay-full';
  if (overlayHeader) return 'overlay';
  if (fullWidth) return 'full';
  return 'standard';
}

/** The WP template slug for a variant. `standard` is the bare `page-replica`. */
export function variantTemplateSlug(key: VariantKey): string {
  return key === 'standard' ? 'page-replica' : `page-replica-${key}`;
}
