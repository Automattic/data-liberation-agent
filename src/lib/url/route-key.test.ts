import { describe, expect, it } from 'vitest';
import { documentRequestUrl, normalizedUrl } from './route-key.js';
import { dedupeRouteInventory } from '../route-budget.js';

describe('discovery route identity', () => {
  it('merges slash, fragment and tracking variants without changing the retained spelling', () => {
    const first = 'https://site.test/about/';
    expect(dedupeRouteInventory([first, 'https://site.test/about', `${first}#team`, `${first}?utm_source=menu`])).toEqual([first]);
    expect(dedupeRouteInventory(['https://site.test/about', first])).toEqual(['https://site.test/about']);
    expect(normalizedUrl('https://site.test/')).toBe('https://site.test/');
  });

  it('keeps origins, semantic queries, case and interior slashes distinct', () => {
    const urls = ['https://site.test/about', 'https://other.test/about/', 'http://site.test/about/',
      'https://site.test/about/?lang=en', 'https://site.test/about?lang=fr',
      'https://site.test/About', 'https://site.test/a//b', 'https://site.test/a/b'];
    expect(dedupeRouteInventory(urls)).toEqual(urls);
  });

  it('does not change the actual network request address', () => {
    expect(documentRequestUrl('https://site.test/about/?lang=en#team')).toBe('https://site.test/about/?lang=en');
  });
});
