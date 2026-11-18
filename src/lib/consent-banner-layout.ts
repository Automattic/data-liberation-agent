import type { ConsentBannerLayout } from './consent-banner.js';

const GEOMETRY = ['width', 'inline_offset', 'edge_offset'] as const;

/** Everything but viewport bounds and panel geometry. */
function shape({ min_width: _min, max_width: _max, width: _width, inline_offset: _offset, edge_offset: _edge, ...rest }: ConsentBannerLayout): string {
  return JSON.stringify(Object.keys(rest).sort().map(key => [key, rest[key as keyof typeof rest]]));
}

/**
 * Shapes whose panel width follows the viewport. A fluid panel (`90%`,
 * `calc(100% - 48px)`) measures on one line across viewports; a fixed panel
 * that steps at a breakpoint does not. Two observations always fit a line,
 * so fluidity takes at least three single-viewport observations.
 */
export function fluidConsentShapes(samples: ConsentBannerLayout[]): Set<string> {
  const groups = new Map<string, Array<[number, number]>>();
  for (const sample of samples) {
    if (sample.width === undefined || sample.min_width === undefined || sample.min_width !== sample.max_width) continue;
    const key = shape(sample);
    groups.set(key, [...(groups.get(key) ?? []), [sample.min_width, sample.width]]);
  }
  const fluid = new Set<string>();
  for (const [key, points] of groups) {
    if (points.length < 3 || new Set(points.map(([, width]) => width)).size < 2) continue;
    points.sort((a, b) => a[0] - b[0]);
    const [[v0, w0], [v1, w1]] = [points[0], points[points.length - 1]];
    if (v0 === v1) continue;
    const slope = (w1 - w0) / (v1 - v0);
    if (points.every(([v, w]) => Math.abs(w0 + slope * (v - v0) - w) <= 2)) fluid.add(key);
  }
  return fluid;
}

/**
 * Observations describe the same layout when everything but their viewport
 * bounds and panel geometry agrees, and their panels have the same width
 * unless that shape is fluid (it measures differently at every width). A
 * panel with one fixed width up to a breakpoint and another beyond it is two
 * layouts.
 */
export function sameConsentLayout(a: ConsentBannerLayout, b: ConsentBannerLayout, fluid: ReadonlySet<string> = new Set()): boolean {
  if (shape(a) !== shape(b)) return false;
  return a.width === undefined || b.width === undefined || a.width === b.width || fluid.has(shape(a));
}

/** Merge adjacent observations (including bisected edges), opening the outer ranges. */
export function mergeConsentLayouts(samples: ConsentBannerLayout[]): ConsentBannerLayout[] {
  const ordered = [...samples].sort((a, b) => (a.min_width ?? 0) - (b.min_width ?? 0));
  const fluid = fluidConsentShapes(samples);
  const result: ConsentBannerLayout[] = [];
  for (const sample of ordered) {
    const previous = result.at(-1);
    if (previous && sameConsentLayout(previous, sample, fluid)) {
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
