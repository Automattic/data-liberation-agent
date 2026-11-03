import type { ConsentBannerLayout } from './consent-banner.js';

/** Keep observed width bounds; do not infer unmeasured CSS breakpoints. */
export function mergeConsentLayouts(samples: ConsentBannerLayout[]): ConsentBannerLayout[] {
  const ordered = [...samples].sort((a, b) => (a.min_width ?? 0) - (b.min_width ?? 0));
  const result: ConsentBannerLayout[] = [];
  for (const sample of ordered) {
    const previous = result.at(-1);
    if (previous && previous.direction === sample.direction
      && previous.align_items === sample.align_items && previous.button_align === sample.button_align) {
      previous.max_width = previous.max_width === undefined || sample.max_width === undefined
        ? undefined : Math.max(previous.max_width, sample.max_width);
    } else {
      result.push({ ...sample });
    }
  }
  return result;
}
