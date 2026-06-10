import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as cheerio from 'cheerio';
import type { LocalPage, LocalSite } from './types.js';

/** Recursively list *.html / *.htm files under root (skips dotdirs, node_modules, and symlinks). */
function listHtmlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      // lstat (not stat) so symlinks are seen as links: skipping them entirely
      // keeps circular links from ELOOP-crashing the walk.
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith('.html') || name.toLowerCase().endsWith('.htm')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** relPath → slug: "index.html" → "home"; "about.html" → "about"; "blog/p.html" → "blog-p". */
export function slugFromRelPath(relPath: string): string {
  const noExt = relPath.replace(/\.html?$/i, '');
  const parts = noExt.split(sep).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last.toLowerCase() === 'index') {
    return parts.length === 1 ? 'home' : parts.slice(0, -1).join('-').toLowerCase();
  }
  return parts.join('-').toLowerCase();
}

export function ingestLocalSite(root: string): LocalSite {
  const files = listHtmlFiles(root);
  if (files.length === 0) throw new Error(`no html pages found under ${root}`);
  const pages: LocalPage[] = files.map((full) => {
    const html = readFileSync(full, 'utf8');
    const $ = cheerio.load(html);
    const relPath = relative(root, full);
    return {
      relPath,
      slug: slugFromRelPath(relPath),
      html,
      title: $('title').first().text().trim(),
    };
  });
  pages.sort((a, b) => a.slug.localeCompare(b.slug));
  // Distinct files can slug-collide (e.g. "blog/p.html" vs "blog-p.html") — downstream
  // writes <slug>-keyed artifacts, so a collision would silently overwrite. Fail loudly.
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.slug)) throw new Error(`slug collision: "${p.slug}" from "${p.relPath}"`);
    seen.add(p.slug);
  }
  return { root, pages };
}
