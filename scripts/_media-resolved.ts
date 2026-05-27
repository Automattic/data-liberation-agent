// Throwaway: build CDN -> /wp-content/uploads/YYYY/MM/<basename> maps from
// media-stubs.json. Emits two shapes in media-resolved.json:
//   - byExact:  { sourceCdnUrl -> uploadUrl } — the flat map (feed straight to
//               liberate_section_extract's `mediaMap`; supersedes media-map.json).
//   - byBaseId: { wixBaseId -> uploadUrl } — lets reconstructed patterns resolve
//               Wix section images when the DOM's transform URL (w_1440,...)
//               differs from the downloaded stub's transform. Wix media URLs look
//               like .../media/<baseId>~mv2.<ext>/v1/fill/.../<name>.<ext>.
// Args: <outputDir> [uploadsMonth=YYYY/MM, defaults to the current month].
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { requireOutputDir, defaultUploadsMonth } from './_site-meta.js';

const outputDir = requireOutputDir('<outputDir> [uploadsMonth=YYYY/MM]');
const uploadsMonth = process.argv[3] ?? defaultUploadsMonth();

const stubs = JSON.parse(readFileSync(join(outputDir, 'media-stubs.json'), 'utf8')) as {
  stubs: Record<string, { status: string; localPath: string }>;
};

const IMG = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
// baseId = the token right after /media/ up to the first '~' or '/'
const baseIdOf = (url: string): string | null => {
  const m = url.match(/\/media\/([^~/]+)[~/]/);
  return m ? m[1] : null;
};

const byBaseId: Record<string, string> = {};
const byExact: Record<string, string> = {};
for (const [src, s] of Object.entries(stubs.stubs)) {
  if (s.status !== 'success') continue;
  const base = basename(s.localPath);
  if (!IMG.test(base)) continue;
  const uploadUrl = `/wp-content/uploads/${uploadsMonth}/${base}`;
  byExact[src] = uploadUrl;
  const id = baseIdOf(src);
  // First write wins (prefer the largest/earliest variant of a base id).
  if (id && !byBaseId[id]) byBaseId[id] = uploadUrl;
}

writeFileSync(
  join(outputDir, 'media-resolved.json'),
  JSON.stringify({ uploadsMonth, byBaseId, byExact }, null, 2),
);
console.log(`media-resolved.json: ${Object.keys(byBaseId).length} base-ids, ${Object.keys(byExact).length} exact urls`);
// Sanity preview: first few resolved base-ids (no per-site ids baked in).
for (const id of Object.keys(byBaseId).slice(0, 5)) {
  console.log(`  ${id} -> ${byBaseId[id]}`);
}
