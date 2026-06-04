/**
 * Drive liberate_reconstruct_pages_carry via tsx (current on-disk code) — the MCP
 * server is long-lived and predates this session's features, so the carry tool may
 * be missing/stale there. Reads the validated page list from <outputDir>/carry-pages.json
 * (built by carry-build-pagelist.mjs), runs the handler, writes the returned islands
 * to <studioSitePath>/wp-content/uploads/_carry-islands/<slug>.html + a _swap.php.
 * Site-generic: all paths from argv.
 *
 *   npx tsx scripts/carry-reconstruct-drive.ts <outputDir> <studioSitePath> "<Theme Name>"
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { reconstructPagesCarryHandler } from '../src/mcp-server/handlers/reconstruct-pages-carry.js';

const [outputDir, studioSitePath, themeName = 'Liberated (Carry)'] = process.argv.slice(2);
if (!outputDir || !studioSitePath) {
  console.error('usage: tsx scripts/carry-reconstruct-drive.ts <outputDir> <studioSitePath> "<Theme Name>"');
  process.exit(2);
}

// --- Page list: validated carry-pages.json (single source of truth) ---------
const pages = JSON.parse(readFileSync(join(outputDir, 'carry-pages.json'), 'utf8')) as Array<Record<string, unknown>>;
console.log(`pages: ${pages.length} (${pages.filter((p) => p.postType === 'post').length} posts, home=${pages.some((p) => p.isHome)})`);

// --- Drive the handler ------------------------------------------------------
const ctx = {
  textResult: (o: unknown) => ({ _data: o }),
  errorResult: (msg: string) => { throw new Error(`handler error: ${msg}`); },
} as unknown as Parameters<typeof reconstructPagesCarryHandler>[1];

const res = (await reconstructPagesCarryHandler(
  { outputDir, studioSitePath, themeName, pages } as unknown as Parameters<typeof reconstructPagesCarryHandler>[0],
  ctx,
)) as { _data: { themeSlug: string; mediaInstalled: number; mediaErrors: unknown[]; fetchErrors: unknown[]; pages: Array<{ slug: string; postType?: string; postContent: string }> } };

const data = res._data;
console.log(`theme: ${data.themeSlug}  media: ${data.mediaInstalled}  mediaErrors: ${data.mediaErrors.length}  fetchErrors: ${data.fetchErrors.length}`);
if (data.mediaErrors.length) console.log('  mediaErrors sample:', JSON.stringify(data.mediaErrors.slice(0, 3)));
if (data.fetchErrors.length) console.log('  fetchErrors:', JSON.stringify(data.fetchErrors));

// --- Write islands + _swap.php ---------------------------------------------
const islandsDir = join(studioSitePath, 'wp-content/uploads/_carry-islands');
mkdirSync(islandsDir, { recursive: true });
const slugs: string[] = [];
for (const p of data.pages) {
  writeFileSync(join(islandsDir, `${p.slug}.html`), p.postContent);
  slugs.push(p.slug);
}
// VFS-path swap script (publishes the post too, so draft-extracted pages render).
// Studio mounts the host site dir at VFS /wordpress.
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
console.log(`THEMESLUG=${data.themeSlug}`);
