import { expect, it } from 'vitest';
import { routeInScope, scopedRouteKey, validateRouteScope } from '../../lib/url/route-scope.js';
import { shopifyAdapter } from './index.js';

it('collapses Shopify link tracking while preserving document-selecting queries', () => {
  const origin = 'https://kafesia.com';
  const scope = shopifyAdapter.routeScope?.(origin);
  const product = `${origin}/products/llavero-molinillo`;
  expect(scope).toBeDefined();
  expect(scopedRouteKey(`${product}?pr_prod_strat=e5_desc&pr_rec_id=448c9ef75&pr_rec_pid=1&pr_ref_pid=2&pr_seq=uniform&pr_request_id=request`, scope)).toBe(product);
  expect(scopedRouteKey(`${product}?_pos=1&_sid=session&_ss=r&_psq=coffee&_fid=filter`, scope)).toBe(product);
  for (const query of ['variant=123', 'page=2', 'filter.v.availability=1', 'sort_by=price-ascending', 'q=coffee']) {
    expect(scopedRouteKey(`${product}?${query}&pr_request_id=request&_pos=1`, scope)).toBe(`${product}?${query}`);
  }
});

it.each(['https://kafesia.com/es', 'https://example.myshopify.com/es'])(
  'keeps all source-origin paths in scope for %s', sourceUrl => {
    const scope = shopifyAdapter.routeScope?.(sourceUrl);
    expect(scope).toMatchObject({ origin: new URL(sourceUrl).origin, pathPrefixes: ['/'] });
    expect(() => validateRouteScope(scope!)).not.toThrow();
    expect(routeInScope(sourceUrl, scope)).toBe(true);
    expect(routeInScope(new URL('/products/coffee', sourceUrl).href, scope)).toBe(true);
    const otherOrigin = sourceUrl.includes('myshopify.com') ? 'https://kafesia.com' : 'https://example.myshopify.com';
    expect(routeInScope(`${otherOrigin}/products/coffee`, scope)).toBe(false);
  },
);
