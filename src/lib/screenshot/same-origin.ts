export class SameOriginViolation extends Error {
  constructor(public violations: string[], public expected: string) {
    super(`Same-origin violation — expected ${expected}, got: ${violations.join(', ')}`);
    this.name = 'SameOriginViolation';
  }
}

/**
 * Throws SameOriginViolation if any URL in `urls` has a different origin than
 * `primaryUrl`. If primaryUrl is null, the first URL in `urls` is used as the
 * reference. Matches the same-origin enforcement in fetchSitemap().
 */
export function enforceSameOrigin(primaryUrl: string | null, urls: string[]): void {
  if (urls.length === 0) return;
  const reference = primaryUrl ?? urls[0];
  let refOrigin: string;
  try {
    refOrigin = new URL(reference).origin;
  } catch {
    throw new Error(`enforceSameOrigin: invalid reference URL: ${reference}`);
  }
  const violations: string[] = [];
  for (const u of urls) {
    try {
      if (new URL(u).origin !== refOrigin) violations.push(u);
    } catch {
      throw new Error(`enforceSameOrigin: invalid URL: ${u}`);
    }
  }
  if (violations.length > 0) throw new SameOriginViolation(violations, refOrigin);
}
