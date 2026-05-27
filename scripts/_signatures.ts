// Throwaway: compute page signatures off saved html/*.html (no re-navigation),
// write them to <outputDir>/page-signatures.json for clustering. The source
// origin is read from the run's WXR, so this works for any extracted site.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractSignature } from '../src/lib/replicate/section-extract.js';
import { requireOutputDir, readSiteMeta } from './_site-meta.js';

const outputDir = requireOutputDir();
const { origin } = readSiteMeta(outputDir);
const htmlDir = join(outputDir, 'html');

// slug → source URL (homepage is the bare origin)
const urlForSlug = (slug: string): string =>
  slug === 'homepage' ? origin : `${origin}/${slug}`;

const sigs = readdirSync(htmlDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => {
    const slug = f.replace(/\.html$/, '');
    const html = readFileSync(join(htmlDir, f), 'utf8');
    return extractSignature(urlForSlug(slug), html, html.length);
  });

writeFileSync(join(outputDir, 'page-signatures.json'), JSON.stringify(sigs, null, 2));
console.log(JSON.stringify(sigs, null, 2));
