import { discoverGeneric } from '../discover-generic.js';

export function discover(url: string, opts: Record<string, unknown>) {
  return discoverGeneric(url, opts, {
    extraSitemaps: ['/sitemap.website.xml', '/sitemap.blog.xml'],
  });
}
