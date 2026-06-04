/**
 * Self-contained tsx driver for the carry-and-scope reconstruct (the `replicate-theme`
 * path). The long-lived MCP server doesn't hot-reload, so `liberate_reconstruct_pages_carry`
 * must run from a fresh tsx process against current on-disk code. This driver does the WHOLE
 * orchestration with NO external inputs beyond the `/liberate` capture already in <outputDir>:
 *
 *   1. Build the page list from output.wxr(.full) + screenshots/manifest.json (internal).
 *   2. Drive reconstructPagesCarryHandler — writes the theme, installs media, returns islands.
 *   3. Write islands + _swap.php into <studioSitePath>/wp-content/uploads/_carry-islands/.
 *   4. Patch the islands into the FULL WXR -> <outputDir>/output-carry.wxr.
 *   5. Restore <outputDir>/output.wxr from output.wxr.full (provision slims it in place;
 *      this leaves the dir non-lossy — a later blocks run / liberate_verify sees the full WXR).
 *
 * Site/platform-generic: all paths from argv. `buildCarryPageList` / `buildOutputCarryWxr`
 * are exported so they can be exercised standalone without running the (heavy) handler.
 *
 *   npx tsx scripts/carry-reconstruct-drive.ts <outputDir> <studioSitePath> "<Theme Name>"
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconstructPagesCarryHandler } from '../src/mcp-server/handlers/reconstruct-pages-carry.js';

/** Read a tag's text from a WXR item block, stripping an optional CDATA wrapper. */
const tag = (block: string, name: string): string => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  const cd = m[1].match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return (cd ? cd[1] : m[1]).trim();
};

/** Prefer the full WXR (output.wxr.full, written by wxr-slim-publish.py) over the possibly-slimmed output.wxr. */
const wxrSource = (outputDir: string): string => {
  const full = join(outputDir, 'output.wxr.full');
  return existsSync(full) ? full : join(outputDir, 'output.wxr');
};

export interface CarryPage {
  slug: string;
  sourceUrl: string;
  title: string;
  postType: 'page' | 'post';
  htmlSlug: string;
  isHome?: boolean;
}

/**
 * Build the carry page list by joining the WXR (authoritative post_name / title / type) to the
 * screenshot manifest (htmlSlug / sourceUrl). Generic across platforms:
 *  - pages: WXR post_name → manifest slug; the front page is captured as `homepage` (matched by
 *    root-URL link OR post_name `home`/`homepage`).
 *  - posts: WXR post_name → manifest `post--<name>` (exact, then prefix-match for %-encoded/truncated slugs).
 */
export function buildCarryPageList(outputDir: string): { pages: CarryPage[]; skipped: unknown[] } {
  const wxr = readFileSync(wxrSource(outputDir), 'utf8');
  const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots', 'manifest.json'), 'utf8'));
  const entries: Record<string, { slug: string }> = manifest.entries ?? manifest;
  const bySlug = new Map<string, { sourceUrl: string }>();
  for (const [url, e] of Object.entries(entries)) bySlug.set(e.slug, { sourceUrl: url });
  const htmlFiles = new Set(readdirSync(join(outputDir, 'html')));

  // Shopify/Squarespace capture pages as `pages--<name>` and posts as
  // `blogs--<blog>--<name>`, while the WXR post_name is the bare `<name>`, so the
  // direct + `post--` lookups below all miss. Fall back to matching post_name against
  // the LAST `--` segment of a manifest slug. Products (`products--*`) are excluded —
  // they're WooCommerce items, not carry pages.
  const byLastSeg = new Map<string, string>();
  for (const slug of bySlug.keys()) {
    if (slug.startsWith('products--')) continue;
    const seg = slug.includes('--') ? slug.slice(slug.lastIndexOf('--') + 2) : slug;
    if (!byLastSeg.has(seg)) byLastSeg.set(seg, slug); // first wins (stable order)
  }

  const items = wxr.split('<item>').slice(1).map((s) => s.split('</item>')[0]);
  const pages: CarryPage[] = [];
  const skipped: unknown[] = [];
  for (const it of items) {
    const postType = tag(it, 'wp:post_type');
    if (postType !== 'page' && postType !== 'post') continue; // skip attachments + nav_menu_item
    const postName = tag(it, 'wp:post_name');
    const title = tag(it, 'title');
    const link = tag(it, 'link');
    const rootLink = /^https?:\/\/[^/]+\/?$/.test(link);

    let htmlSlug: string | null = null;
    let sourceUrl = link;
    if (postType === 'page') {
      if (bySlug.has(postName)) { htmlSlug = postName; sourceUrl = bySlug.get(postName)!.sourceUrl; }
      else if (htmlFiles.has(`${postName}.html`)) htmlSlug = postName;
      else if ((rootLink || postName === 'home' || postName === 'homepage') && bySlug.has('homepage')) {
        htmlSlug = 'homepage';
        sourceUrl = bySlug.get('homepage')!.sourceUrl;
      }
      else if (byLastSeg.has(postName)) { htmlSlug = byLastSeg.get(postName)!; sourceUrl = bySlug.get(htmlSlug)!.sourceUrl; }
    } else {
      const exact = `post--${postName}`;
      if (bySlug.has(exact)) { htmlSlug = exact; sourceUrl = bySlug.get(exact)!.sourceUrl; }
      else {
        const cand = [...bySlug.keys()].filter((k) => k.startsWith('post--') && (k.startsWith(exact) || exact.startsWith(k)));
        if (cand.length === 1) { htmlSlug = cand[0]; sourceUrl = bySlug.get(cand[0])!.sourceUrl; }
        else if (byLastSeg.has(postName)) { htmlSlug = byLastSeg.get(postName)!; sourceUrl = bySlug.get(htmlSlug)!.sourceUrl; }
      }
    }

    if (!htmlSlug || !htmlFiles.has(`${htmlSlug}.html`)) {
      skipped.push({ postType, postName, title, link, reason: htmlSlug ? 'html-missing' : 'no-manifest-match' });
      continue;
    }
    const isHome = postType === 'page' && (htmlSlug === 'homepage' || rootLink);
    pages.push({ slug: isHome ? (postName || 'home') : postName, sourceUrl, title, postType, htmlSlug, ...(isHome ? { isHome: true } : {}) });
  }
  return { pages, skipped };
}

/**
 * Patch carry islands into the FULL WXR -> output-carry.wxr. Per-item transform with a FUNCTION
 * replacer (never a string — avoids the `$&`/`$1` footgun); CDATA-escapes any `]]>` in the island;
 * leaves attachments + nav untouched. Returns counters so the caller can verify the round-trip.
 */
export function buildOutputCarryWxr(outputDir: string, islandsDir: string): {
  items: number; patched: number; cdataBalanced: boolean; outPath: string;
} {
  const src = readFileSync(wxrSource(outputDir), 'utf8');
  const parts = src.split(/(<item>[\s\S]*?<\/item>)/);
  let items = 0;
  let patched = 0;
  const out = parts.map((p) => {
    if (!p.startsWith('<item>')) return p;
    items++;
    const postType = tag(p, 'wp:post_type');
    if (postType !== 'page' && postType !== 'post') return p;
    const postName = tag(p, 'wp:post_name');
    const islandPath = join(islandsDir, `${postName}.html`);
    if (!existsSync(islandPath)) return p;
    const island = readFileSync(islandPath, 'utf8').replace(/]]>/g, ']]]]><![CDATA[>');
    const replacement = `<content:encoded><![CDATA[${island}]]></content:encoded>`;
    return p.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, () => { patched++; return replacement; });
  }).join('');
  const outPath = join(outputDir, 'output-carry.wxr');
  writeFileSync(outPath, out);
  const cdataBalanced = (out.match(/<!\[CDATA\[/g) || []).length === (out.match(/]]>/g) || []).length;
  return { items, patched, cdataBalanced, outPath };
}

async function main(): Promise<void> {
  const [outputDir, studioSitePath, themeName = 'Liberated (Carry)'] = process.argv.slice(2);
  if (!outputDir || !studioSitePath) {
    console.error('usage: tsx scripts/carry-reconstruct-drive.ts <outputDir> <studioSitePath> "<Theme Name>"');
    process.exit(2);
  }

  // 1. page list (internal — self-contained; also written as an audit artifact)
  const { pages, skipped } = buildCarryPageList(outputDir);
  writeFileSync(join(outputDir, 'carry-pages.json'), JSON.stringify(pages, null, 2));
  console.log(`pages: ${pages.length} (${pages.filter((p) => p.postType === 'post').length} posts, home=${pages.some((p) => p.isHome)})`);
  if (skipped.length) console.log(`SKIPPED ${skipped.length}:`, JSON.stringify(skipped));

  // 2. drive the handler (theme + media + islands)
  const ctx = {
    textResult: (o: unknown) => ({ _data: o }),
    errorResult: (msg: string) => { throw new Error(`handler error: ${msg}`); },
  } as unknown as Parameters<typeof reconstructPagesCarryHandler>[1];
  const res = (await reconstructPagesCarryHandler(
    { outputDir, studioSitePath, themeName, pages } as unknown as Parameters<typeof reconstructPagesCarryHandler>[0],
    ctx,
  )) as { _data: { themeSlug: string; mediaInstalled: number; mediaErrors: unknown[]; fetchErrors: unknown[]; pages: Array<{ slug: string; postContent: string }> } };
  const data = res._data;
  console.log(`theme: ${data.themeSlug}  media: ${data.mediaInstalled}  mediaErrors: ${data.mediaErrors.length}  fetchErrors: ${data.fetchErrors.length}`);
  if (data.mediaErrors.length) console.log('  mediaErrors sample:', JSON.stringify(data.mediaErrors.slice(0, 3)));
  if (data.fetchErrors.length) console.log('  fetchErrors:', JSON.stringify(data.fetchErrors));

  // 3. islands + _swap.php (VFS path; Studio mounts the host site dir at /wordpress)
  const islandsDir = join(studioSitePath, 'wp-content/uploads/_carry-islands');
  mkdirSync(islandsDir, { recursive: true });
  const slugs: string[] = [];
  for (const p of data.pages) {
    writeFileSync(join(islandsDir, `${p.slug}.html`), p.postContent);
    slugs.push(p.slug);
  }
  const swap = `<?php
$dir = '/wordpress/wp-content/uploads/_carry-islands';
$slugs = ${JSON.stringify(slugs)};
foreach ($slugs as $slug) {
  $file = "$dir/$slug.html";
  if (!file_exists($file)) { echo "MISSING $slug\\n"; continue; }
  $content = file_get_contents($file);
  $posts = get_posts(['name'=>$slug,'post_type'=>['page','post'],'post_status'=>'any','numberposts'=>1]);
  if (empty($posts)) { echo "NO POST $slug\\n"; continue; }
  $r = wp_update_post(['ID'=>$posts[0]->ID,'post_content'=>$content,'post_status'=>'publish'], true);
  if (is_wp_error($r)) echo "ERR $slug: ".$r->get_error_message()."\\n";
  else echo "OK $slug id=".$posts[0]->ID." bytes=".strlen($content)."\\n";
}
`;
  writeFileSync(join(islandsDir, '_swap.php'), swap);
  console.log(`islands written: ${slugs.length} -> ${islandsDir}`);

  // 4. build output-carry.wxr (patch islands into the FULL WXR — the import deliverable)
  const wxr = buildOutputCarryWxr(outputDir, islandsDir);
  console.log(`output-carry.wxr: items=${wxr.items} patched=${wxr.patched} cdataBalanced=${wxr.cdataBalanced} -> ${wxr.outPath}`);

  // 5. heal the dir: provision (wxr-slim-publish.py) slimmed output.wxr in place; restore the full
  //    one so a later blocks run / liberate_verify doesn't see an attachment-less WXR.
  const full = join(outputDir, 'output.wxr.full');
  if (existsSync(full)) {
    copyFileSync(full, join(outputDir, 'output.wxr'));
    console.log('restored output.wxr from output.wxr.full (non-lossy)');
  }

  console.log(`THEMESLUG=${data.themeSlug}`);
}

// Run only when executed directly — keeps buildCarryPageList / buildOutputCarryWxr importable.
if (process.argv[1]?.endsWith('carry-reconstruct-drive.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
