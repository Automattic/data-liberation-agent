import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as cheerio from 'cheerio';
import type { LocalPage, LocalSite } from './types.js';

/** Recursively list *.html files under root (skips dotdirs and node_modules). */
function listHtmlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith('.html')) out.push(full);
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
  if (last === 'index') {
    return parts.length === 1 ? 'home' : parts.slice(0, -1).join('-');
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
  return { root, pages };
}
