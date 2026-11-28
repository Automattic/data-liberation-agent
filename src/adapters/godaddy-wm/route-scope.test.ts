import { expect, it } from 'vitest';
import { routeInScope } from '../../lib/url/route-scope.js';
import { godaddyWmAdapter } from './index.js';

it('excludes membership account routes but keeps pages, blog posts and the store', () => {
  const origin = 'https://example.com';
  const scope = godaddyWmAdapter.routeScope?.(`${origin}/`);
  for (const path of ['/m', '/m/', '/m/login', '/m/reset', '/m/create', '/m/create-account', '/m/login?redirect=%2F']) {
    expect(routeInScope(origin + path, scope), path).toBe(false);
  }
  for (const path of ['/', '/about', '/news/f/a-post', '/f/a-post', '/ols/products/a-product', '/m-and-more']) {
    expect(routeInScope(origin + path, scope), path).toBe(true);
  }
});
