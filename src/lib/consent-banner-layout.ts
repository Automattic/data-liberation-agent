import type { ConsentBannerLayout } from './consent-banner.js';

const GEOMETRY = ['width', 'inline_offset'] as const;

/**
 * Observations describe the same layout when everything but their viewport
 * bounds and panel geometry agrees. Geometry is a fixed size only while it is
 * constant: a fluid panel measures differently at every width.
 */
export function sameConsentLayout(a: ConsentBannerLayout, b: ConsentBannerLayout): boolean {
  const shape = ({ min_width: _min, max_width: _max, width: _width, inline_offset: _offset, ...rest }: ConsentBannerLayout) =>
    JSON.stringify(Object.keys(rest).sort().map(key => [key, rest[key as keyof typeof rest]]));
  return shape(a) === shape(b);
}

/** Merge adjacent observations (including bisected edges), opening the outer ranges. */
export function mergeConsentLayouts(samples: ConsentBannerLayout[]): ConsentBannerLayout[] {
  const ordered = [...samples].sort((a, b) => (a.min_width ?? 0) - (b.min_width ?? 0));
  const result: ConsentBannerLayout[] = [];
  for (const sample of ordered) {
    const previous = result.at(-1);
    if (previous && sameConsentLayout(previous, sample)) {
      previous.max_width = previous.max_width === undefined || sample.max_width === undefined
        ? undefined : Math.max(previous.max_width, sample.max_width);
      for (const key of GEOMETRY) if (previous[key] !== sample[key]) delete previous[key];
    } else {
      result.push({ ...sample });
    }
  }
  if (result.length) {
    delete result[0].min_width;
    delete result[result.length - 1].max_width;
  }
  return result;
}
