import { createHash } from 'node:crypto';
import { downloadMedia, existingMediaNames } from './media-fetch/media.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect } from 'vitest';
import { it } from '../../test/browser.js';
import { captureWebsite } from '../index.js';
import { defaultAdapter } from '../adapters/default/index.js';
import { nextjsAdapter } from '../adapters/nextjs/index.js';
import { captureAssets, collectAssets as collectImageAssets, imageContentType, resourceContentType, resolvedImageOriginal, svgDeclaredSize } from './image-assets.js';
import { AssetAcquisitionQueue } from './asset-acquisition-queue.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';
import { downloadCaptureSectionMedia } from './capture.js';
import { MediaStubStore } from './resume-state/index.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';

it.each([
 ['commented viewBox before sizeless root', '<?xml version="1.0" encoding="utf-8"?><!-- <svg viewBox="0 0 100 100"> --><svg xmlns="http://www.w3.org/2000/svg"><line x2="100%" y2="100%" /></svg>', undefined],
 ['commented size before sized root', '<!-- <svg width="10" height="10"> --><svg width="40" height="20"/>', { width: 40, height: 20 }],
 ['plain sized root', '<svg width="40" height="20"/>', { width: 40, height: 20 }],
 ['CDATA', '<![CDATA[<svg width="10" height="10">]]><svg width="40" height="20"/>', { width: 40, height: 20 }],
 ['processing instruction', '<?example <svg width="10" height="10"> ?><svg width="40" height="20"/>', { width: 40, height: 20 }],
 ['DOCTYPE internal subset', '<!DOCTYPE svg [<!ENTITY example "<svg width=\'10\' height=\'10\'>">]><svg width="40" height="20"/>', { width: 40, height: 20 }],
])('reads the real SVG root size: %s', (_name, xml, expected) => {
 expect(svgDeclaredSize(Buffer.from(xml as string))).toEqual(expected);
});

it.each([
 ['citation text', Buffer.from('Smith, J. (2024). A useful citation. Journal of Examples, 12(3), 45–67.'), '/citation.txt', 'text/plain'],
 ['same text at PDF URL', Buffer.from('Smith, J. (2024). A useful citation. Journal of Examples, 12(3), 45–67.'), '/citation.pdf', undefined],
 ['HTML body', Buffer.from('  <!DOCTYPE html><html><body>not a document download</body></html>'), '/citation.txt', undefined],
 ['NUL-containing bytes', Buffer.from([0x61, 0x00, 0x62]), '/citation.txt', undefined],
 ['empty body', Buffer.alloc(0), '/citation.txt', undefined],
])('verifies document bytes as plain text only when safe: %s', (_name, bytes, path, expected) => {
 expect(resourceContentType(bytes, 'document', path)).toBe(expected);
});

it('records stored JPEG dimensions and EXIF orientation through capture asset export', async () => {
 mkdirSync('.tmp-test', { recursive: true });
 const root = mkdtempSync('.tmp-test/image-orientation-');
 try {
  const jpeg = readFileSync('test/fixtures/resource-assets/tall-1920x2880.jpg');
  // APP1 Exif: little-endian TIFF, one SHORT Orientation entry (6 = 90° CW).
  const exif = Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const bytes = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
  mkdirSync(join(root, 'resources'));
  writeFileSync(join(root, 'resources/rotated.jpg'), bytes);
  writeFileSync(join(root, 'resources/manifest.json'), JSON.stringify({ resources: {
   'https://example.com/rotated.jpg': { path: 'resources/rotated.jpg', contentType: 'image/jpeg' },
  } }));
  const [record] = await captureAssets(root, [{ url: 'https://example.com/', html: '<img src="/rotated.jpg">' }], Date.now() - 1);
  expect(record.error).toBeUndefined();
  expect(record.original).toMatchObject({ content_type: 'image/jpeg', width: 1920, height: 2880, orientation: 6, sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(readFileSync(record.local_path!)).toEqual(bytes);
  expect(JSON.parse(readFileSync(join(root, 'image-assets.json'), 'utf8')).images[0].original).toEqual(record.original);
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

it('chooses the largest srcset candidate and delegates optimizer resolution to the adapter', () => {
 const records = collectImageAssets([{ url: 'https://example.com/', html: '<img src="small.webp" srcset="large.webp 900w, small.webp 100w"><div style="background:url(small.webp)"></div>' }]);
 expect(records).toHaveLength(1);
 expect(records[0].resolved_original).toBe('https://example.com/large.webp');
 expect(records[0].source_urls).toEqual(expect.arrayContaining(['https://example.com/small.webp', 'https://example.com/large.webp']));
 expect(resolvedImageOriginal('https://example.com/_next/image?url=%2Flogo.webp&w=640&q=75', nextjsAdapter.resolveImageOriginal)).toBe('https://example.com/logo.webp');
});

it.each([
 ['shared lazy placeholder', '/w1/default_thumb.png', '/w1/default_thumb.png', true, false],
 ['picture lazy placeholder', '/w1/default_thumb.png', '/w1/default_thumb.png', true, true],
 ['ordinary src renditions', '/first-small.jpg', '/second-small.jpg', false, false],
] as const)('keeps srcset identities across documents: %s', (_name, firstSrc, secondSrc, placeholder, picture) => {
 const sets = [
  ['/first-small.jpg', '/first-large.jpg'],
  ['/second-small.jpg', '/second-large.jpg'],
 ];
 const records = collectImageAssets([firstSrc, secondSrc].map((src, index) => ({
  url: `https://example.com/page-${index}`,
  html: `${picture ? '<picture>' : ''}<img src="${src}" srcset="${sets[index][0]} 225w, ${sets[index][1]} 510w">${picture ? '</picture>' : ''}<style>.card{background:url(${src})}</style>`,
 })));
 expect(records).toHaveLength(placeholder ? 3 : 2);
 for (const urls of sets) {
  const record = records.find(record => record.source_urls.includes(`https://example.com${urls[0]}`))!;
  expect(record.source_urls).toEqual(urls.map(url => `https://example.com${url}`));
  expect(record.resolved_original).toBe(`https://example.com${urls[1]}`);
  expect(record.references.every(ref => record.source_urls.includes(ref.source_url))).toBe(true);
 }
 if (placeholder) {
  const fallback = records.find(record => record.source_urls.includes(`https://example.com${firstSrc}`))!;
  expect(fallback.source_urls).toEqual([`https://example.com${firstSrc}`]);
  expect(fallback.resolved_original).toBe(`https://example.com${firstSrc}`);
  expect(fallback.references.map(ref => ref.kind).sort()).toEqual(['CSS', 'CSS', 'content', 'content']);
 }
});

it('maps Base44 public renditions to originals without changing unrelated hosts or API originals', () => {
 const original = 'https://media.base44.com/images/public/app/photo.jpeg';
 const rendition = `${original}/v1/fill/w_379,h_237,enc_webp/photo.webp`;
 const records = collectImageAssets([{ url: 'https://example.com/', html: `<img src="${rendition}"><img src="${original}">` }], defaultAdapter.resolveImageOriginal);
 expect(records).toHaveLength(1);
 expect(records[0].resolved_original).toBe(original);
 expect(records[0].source_urls).toEqual(expect.arrayContaining([original, rendition]));
 for (const url of ['https://base44.app/api/apps/app/files/mp/public/app/photo.jpg', rendition.replace('media.base44.com', 'other.example')])
  expect(resolvedImageOriginal(url, defaultAdapter.resolveImageOriginal)).toBe(url);
});

it('keeps generic optimizer-shaped URLs opaque and bounds adapter resolution to HTTP(S) targets', () => {
 const proxy = 'https://example.com/_next/image?url=%2Flogo.webp&w=640';
 expect(resolvedImageOriginal(proxy)).toBe(proxy);
 expect(resolvedImageOriginal(proxy, () => 'data:image/png;base64,AA')).toBe(proxy);
 expect(resolvedImageOriginal(proxy, value => value === proxy ? '/logo.webp' : proxy)).toBe(proxy);
 let steps = 0;
 resolvedImageOriginal(proxy, () => `https://example.com/image-${++steps}`);
 expect(steps).toBe(32);
});

it('prefers an enclosing lightbox original across documents without merging ordinary navigation', () => {
 const records = collectImageAssets([
  { url: 'https://example.com/', html: '<img srcset="/small.webp 100w, /large.webp 900w"><a href="/article"><img src="/other.webp"></a>' },
  { url: 'https://example.com/gallery', html: '<a data-lightbox href="/original?id=1"><img src="/small.webp"></a><link rel="icon" href="/large.webp"><style>.hero{background-image:url(/small.webp)}</style>' },
  { url: 'https://example.com/last', html: '<img srcset="/small.webp 100w, /large.webp 900w">' },
 ]);
 expect(records).toHaveLength(2);
 const image = records.find(record => record.source_urls.includes('https://example.com/small.webp'))!;
 expect(image.resolved_original).toBe('https://example.com/original?id=1');
 expect(image.source_urls).not.toContain('https://example.com/article');
 expect(new Set(image.references.map(ref => ref.kind))).toEqual(new Set(['content', 'head', 'CSS']));
 expect(image.references).toContainEqual({ kind: 'content', document_url: 'https://example.com/gallery', location: 'anchor:0:href', source_url: 'https://example.com/original?id=1' });
});

it('records extensionless font, CSS background and video sources with document bases', () => {
 const records = collectImageAssets([{ url: 'https://example.com/page/', html: '<base href="/assets/"><style>@font-face{src:url(font-proxy?id=1)}.hero{background-image:url(image-proxy?id=2)}</style><video><source src="movie.mp4"></video><div style="background:url(&quot;image-proxy?id=2&quot;)"></div>' }]);
 expect(records).toHaveLength(3);
 expect(records.find(record => record.kind === 'image')!.source_urls).toEqual(['https://example.com/assets/image-proxy?id=2']);
 expect(records.find(record => record.kind === 'font')!.destination_owner).toBe('theme');
 expect(records.find(record => record.kind === 'video')!.destination_owner).toBe('media-library');
 expect(imageContentType(Buffer.from('<html>placeholder</html>'))).toBeUndefined();
 // The bulletproof @font-face: browsers load the last src only, and never its EOT entry.
 const face = collectImageAssets([{ url: 'https://example.com/', html: '<style>@font-face{font-family:Cabin;src:url(/cabin.eot);src:url(/cabin.eot?#iefix) format("embedded-opentype"),url(/cabin.woff) format("woff")}</style>' }]);
 expect(face.map(record => record.resolved_original)).toEqual(['https://example.com/cabin.woff']);
});

it('joins overlapping srcsets without losing the largest original when another document has smaller candidates', () => {
 const records = collectImageAssets([
  { url: 'https://example.com/', html: '<img srcset="large.webp 900w, small.webp 100w">' },
  { url: 'https://example.com/other/', html: '<img srcset="/small.webp 100w, /medium.webp 400w">' },
 ]);
 expect(records).toHaveLength(1);
 expect(records[0].resolved_original).toBe('https://example.com/large.webp');
 expect(records[0].source_urls).toHaveLength(3);
});

describe.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('Next.js-shaped public capture fixture (~15s)', () => {
 it('verifies a redirected Base44-shaped API original (~1s)', async ({ serve }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>';
  const hits: string[] = [];
  const { server } = await serve((request, response) => {
   hits.push(request.url!);
   if (request.url!.startsWith('/api/')) { response.writeHead(302, { location: '/original.svg' }); response.end(); }
   else { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg); }
  });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'redirected-original-'));
  try {
   const source = `${url}/api/apps/app/files/mp/public/app/photo.svg`;
   const records = await runWithTrustedOrigins([url], () => captureAssets(root, [{ url, html: `<img src="${source}">` }], undefined, defaultAdapter.resolveImageOriginal));
   expect(records[0].original).toMatchObject({ source_url: source, content_type: 'image/svg+xml', width: 20, height: 10 });
   expect(readFileSync(records[0].local_path!, 'utf8')).toBe(svg);
   expect(hits).toEqual(['/api/apps/app/files/mp/public/app/photo.svg', '/original.svg']);
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 });

 it('admits locally captured bytes after the deadline but records new downloads as deadline-skipped', async () => {
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'image-deadline-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';
  try {
   mkdirSync(join(root, 'resources'), { recursive: true });
   writeFileSync(join(root, 'resources/logo.svg'), svg);
   // A viewBox-only SVG records its own size, not the browser's 300px default object size.
   writeFileSync(join(root, 'resources/badge.svg'), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 135 40"><rect width="135" height="40"/></svg>');
   writeFileSync(join(root, 'resources/manifest.json'), JSON.stringify({ version: 1, resources: {
    'https://example.com/logo.svg': { path: 'resources/logo.svg', contentType: 'image/svg+xml' },
    'https://example.com/badge.svg': { path: 'resources/badge.svg', contentType: 'image/svg+xml' },
   }, failures: [] }));
   const records = await captureAssets(root, [{ url: 'https://example.com/', html: '<img src="/logo.svg"><img src="/badge.svg"><img src="/uncaptured.svg">' }], Date.now() - 1000);
   const local = records.find(record => record.resolved_original.endsWith('/logo.svg'))!;
   expect(local.original).toMatchObject({ content_type: 'image/svg+xml', width: 20, height: 10 });
   expect(records.find(record => record.resolved_original.endsWith('/badge.svg'))!.original).toMatchObject({ width: 135, height: 40 });
   expect(local.local_path).toBe(join(root, 'media/logo.svg'));
   expect(readFileSync(local.local_path!, 'utf8')).toBe(svg);
   expect(local.error).toBeUndefined();
   expect(local.references[0].source_url).toBe('https://example.com/logo.svg');
   const remote = records.find(record => record.resolved_original.endsWith('/uncaptured.svg'))!;
   expect(remote.original).toBeNull();
   expect(remote.local_path).toBeUndefined();
   expect(remote.error).toBe('Error: resource acquisition deadline reached');
  } finally {
   rmSync(root, { recursive: true, force: true });
  }
 });

 it.for([
  ['while routes can still start', 60_000, 2],
  ['once route admission has closed', -1, 6],
 ] as const)('limits concurrent asset downloads %s', async ([_name, closesIn, expected], { serve }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2"/></svg>';
  let inFlight = 0, most = 0;
  const { server } = await serve((_request, response) => {
   most = Math.max(most, ++inFlight);
   setTimeout(() => { inFlight--; response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg); }, 100);
  });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'asset-queue-'));
  try {
   mkdirSync(join(root, 'html'), { recursive: true });
   writeFileSync(join(root, 'html/index.html'), Array.from({ length: 8 }, (_, i) => `<img src="/${i}.svg">`).join(''));
   await runWithTrustedOrigins([url], async () => {
    const queue = new AssetAcquisitionQueue(root, Date.now() + 60_000, undefined, undefined, Date.now() + closesIn);
    queue.enqueueRoute(url, ['html/index.html']);
    await queue.drain();
   });
   expect(most).toBe(expected);
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 });

 it('fetches a captured route\'s lightbox original before the deadline so assets admit it afterwards', async ({ serve }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
  let hits = 0;
  const { server } = await serve((request, response) => { hits++; response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg); });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'asset-queue-'));
  try {
   const html = '<a href="/full.svg"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></a>';
   mkdirSync(join(root, 'html'), { recursive: true });
   writeFileSync(join(root, 'html/index.html'), html);
   await runWithTrustedOrigins([url], async () => {
    // Routes finish inside the budget; the asset stage starts after it.
    const queue = new AssetAcquisitionQueue(root, Date.now() + 60_000);
    queue.enqueueRoute(url, ['html/index.html', 'html/index.html']);
    await queue.drain();
    const [record] = await captureAssets(root, [{ url, html }], Date.now() - 1000);
    expect(record.resolved_original).toBe(`${url}full.svg`);
    expect(record.error).toBeUndefined();
    expect(record.original).toMatchObject({ width: 40, height: 20 });
   });
   expect(hits).toBe(1);
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 });

 it('acquires and verifies a real srcset rendition rather than reusing original stub aliases', async ({ serve }) => {
  const hits: string[] = [];
  const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"><rect width="${width}" height="10"/>${width > 300 ? '<!--' + 'x'.repeat(1000) + '-->' : ''}</svg>`;
  let failAdequate = false;
  const { server } = await serve((request, response) => { hits.push(request.url!); if (failAdequate && request.url!.includes('300')) { response.writeHead(500); response.end(); return; } response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg(Number(/w=(\d+)/.exec(request.url!)?.[1] ?? 1800))); });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'responsive-bytes-'));
  try {
   await runWithTrustedOrigins([url], async () => {
    mkdirSync(join(root, 'media'), { recursive: true });
    const originalPath = join(root, 'media/original.svg');
    writeFileSync(originalPath, svg(1800));
    const stubs = MediaStubStore.load(root);
    for (const source of ['photo.svg', 'photo.svg?w=100', 'photo.svg?w=300', 'photo.svg?w=1800']) stubs.markSuccess(`${url}${source}`, originalPath);
    stubs.flush();
    // An uncaptured alias without a width must not become an acquisition job;
    // uncaptured width alternatives still use nearest-adequate/fallback ordering.
    const documents = [{ url, html: '<picture><source srcset="photo.svg?w=100 100w, photo.svg?w=300 300w, photo.svg?w=1800 1800w"><img style="width:250px" src="photo.svg"></picture><img src="photo.svg?alias=uncaptured">' }];
    const [record] = await captureAssets(root, documents, Date.now() + 30000, source => source.split('?')[0]);
    const small = record.renditions!.find(child => child.original);
    expect(record.source_urls).toContain(`${url}photo.svg?alias=uncaptured`);
    // Only the nearest adequate rendition is fetched when it succeeds.
    expect(hits).toEqual(['/photo.svg?w=300']);
    expect(record.renditions).toHaveLength(1);
    expect(record.rendered_width).toBe(250);
    expect(record.renditions![0].original?.width).toBe(300);
    expect(small?.original).toMatchObject({ source_url: `${url}photo.svg?w=300`, width: 300 });
    expect(readFileSync(small!.local_path!, 'utf8')).toBe(svg(300));
    expect(small!.original!.sha256).not.toBe(record.original!.sha256);
    hits.length = 0;
    const [expired] = await captureAssets(root, documents, Date.now() - 1, source => source.split('?')[0]);
    expect(expired.renditions ?? []).toEqual([]);
    expect(hits).toEqual([]);
    // A failed adequate rendition falls back to the next smaller one.
    failAdequate = true;
    const [fallback] = await captureAssets(root, documents, Date.now() + 30000, source => source.split('?')[0]);
    expect(hits).toEqual(['/photo.svg?w=300', '/photo.svg?w=100']);
    expect(fallback.renditions!.map(child => child.original?.width)).toEqual([100]);
   });
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 });

 it('preserves verified hashes across independent writers and a lying-header rendition rename (~1s)', async ({ serve }) => {
  const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"><rect width="${width}" height="10"/></svg>`;
  let duringRendition: (() => Promise<void>) | undefined;
  const { server } = await serve(async (request, response) => {
   // Keep the URL/header as JPEG so captureAssets must correct it from decoded bytes.
   if (request.url!.includes('500w')) await duringRendition!();
   response.writeHead(200, { 'content-type': request.url!.includes('500w') ? 'image/jpeg' : 'image/svg+xml' });
   response.end(svg(request.url!.includes('500w') ? 500 : 1500));
  });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'media-writers-'));
  try {
   await runWithTrustedOrigins([url], async () => {
    const mediaDir = join(root, 'media');
    mkdirSync(mediaDir);
    const earlyNames = existingMediaNames(mediaDir);
    const [original] = await captureAssets(root, [{ url, html: '<img src="/JS200/Step+2+-+wetting-2.jpg?format=300w">' }]);
    expect(original.original).not.toBeNull();
    // A captureAssets snapshot predates another writer's output. Publish two
    // same-slug sources while it waits for its rendition; the correction must
    // not rename onto the other writer's newly-created SVG.
    const lateRecords: Array<{ local_path: string; original: { sha256: string } }> = [];
    duringRendition = () => runWithTrustedOrigins([url], async () => {
     for (const name of ['Step+2+wetting+2.svg', 'Step+2+wetting+2-2.svg']) {
      const result = await downloadMedia(`${url}F7Q29/${name}`, mediaDir, earlyNames);
      expect(result.error).toBeNull();
      lateRecords.push({ local_path: result.localPath!, original: { sha256: createHash('sha256').update(readFileSync(result.localPath!)).digest('hex') } });
     }
    });
    const [parent] = await captureAssets(root, [{ url, html: '<img width="400" src="/JS200/Step+2+-+wetting-2.jpg?format=300w" srcset="/JS200/Step+2+-+wetting-2.jpg?format=500w 500w, /JS200/Step+2+-+wetting-2.jpg?format=1500w 1500w">' }], undefined, source => source.replace(/format=\d+w/, 'format=300w'));
    expect(parent.renditions).toHaveLength(1);
    const records = [original, parent, ...parent.renditions!, ...lateRecords];
    for (const record of records) {
     expect(record.original).not.toBeNull();
     expect(createHash('sha256').update(readFileSync(record.local_path!)).digest('hex')).toBe(record.original!.sha256);
    }
   });
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 });

 it('keeps a verified original when later section media shares its filename', async ({ serve }) => {
  const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"><rect width="${width}" height="10"/></svg>`;
  const { server } = await serve((request, response) => { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg(request.url!.startsWith('/large/') ? 40 : 20)); });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'media-names-'));
  try {
   await runWithTrustedOrigins([url], async () => {
    // Two CDN renditions of one image share a basename, as Wix transform URLs do.
    const [record] = await captureAssets(root, [{ url, html: '<img src="/small/photo.svg">' }]);
    SectionSpecsStore.load(root).set(url, [{ sectionIndex: 0, images: [{ url: `${url}large/photo.svg` }], cells: [] } as never], []);
    expect(await downloadCaptureSectionMedia(root, [url])).toBe(1);
    expect(readFileSync(record.local_path!, 'utf8')).toBe(svg(20));
   });
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 });

 it('exports one alpha-preserving original with every srcset/proxy/CSS URL and flags unresolved images', async ({ serve, newPage }) => {
  const page = await newPage();
  const data = await page.evaluate(() => {
   const c = document.createElement('canvas'); c.width = 203; c.height = 90;
   c.getContext('2d')!.fillRect(0, 0, 100, 90);
   return { webp: c.toDataURL('image/webp').split(',')[1], jpeg: c.toDataURL('image/jpeg').split(',')[1] };
  });
  await page.context().close();
  const webp = Buffer.from(data.webp, 'base64'), jpeg = Buffer.from(data.jpeg, 'base64');
  const proxy = (w: number) => `/_next/image?url=%2Fpreview.webp&w=${w}&q=75`;
  const { server } = await serve((request, response) => {
   const path = new URL(request.url!, 'http://example.com').pathname;
   // Deliberately lie about the format: metadata and filename must follow bytes.
   if (path === '/logo.webp') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(webp); }
   else if (path === '/_next/image' || path === '/preview.webp') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(jpeg); }
   else if (path === '/hero.css') { response.writeHead(200, { 'content-type': 'text/css' }); response.end(`.hero{background-image:url('${proxy(203)}')}`); }
   else if (path === '/missing.webp') { response.writeHead(200, { 'content-type': 'image/webp' }); response.end('<html>placeholder</html>'); }
   else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><title>Next image fixture</title><link rel="stylesheet" href="/hero.css"><link rel="icon" href="${proxy(67)}"><link rel="apple-touch-icon" href="/logo.webp"><h1>Transparent logo</h1><nav><a href="/logo.webp"><img alt="Logo" src="${proxy(67)}" srcset="${proxy(203)} 203w, ${proxy(67)} 67w"></a></nav><img alt="Content logo" src="${proxy(67)}"><div class="hero" style="width:203px;height:90px;background-image:url('${proxy(67)}')"></div><img alt="Missing" src="/missing.webp">`); }
  });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'next-image-'));
  try {
   const result = await captureWebsite({ url, outputDir: root, trustedOrigins: [url], learnFluid: false, routeLimit: 1 }, { findAdapter: () => ({ ...nextjsAdapter, discover: async () => ({ urls: [] }) }) });
   const records = JSON.parse(readFileSync(join(root, 'image-assets.json'), 'utf8')).images;
   expect(records).toHaveLength(2);
   const logo = records.find((r: any) => r.original);
   expect(logo.resolved_original).toBe(`${url}logo.webp`);
   expect(logo.original).toMatchObject({ source_url: `${url}logo.webp`, content_type: 'image/webp', width: 203, height: 90, alpha: true });
   expect(logo.source_urls).toEqual(expect.arrayContaining([`${url}logo.webp`, new URL(proxy(67), url).href, new URL(proxy(203), url).href]));
   const receipt = JSON.parse(readFileSync(result.captureReceiptPath, 'utf8'));
   const images = receipt.assets.filter((asset: any) => asset.original);
   expect(images).toHaveLength(1);
   expect(receipt.assets.filter((asset: any) => /\.(?:webp|jpe?g|png)(?:$|[?#])/i.test(asset.path))).toHaveLength(1);
   expect(images[0].source_url).toBe(`${url}logo.webp`);
   expect(new Set(logo.references.map((ref: any) => ref.kind))).toEqual(new Set(['content', 'navigation', 'head', 'CSS']));
   expect(images[0].references).toEqual(logo.references);
   expect(logo.references).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'CSS', document_url: `${url}hero.css` })]));
   const stylesheets = receipt.assets.filter((asset: any) => asset.path.endsWith('.css')).map((asset: any) => readFileSync(join(root, asset.path), 'utf8')).join('\n');
   expect(stylesheets).toContain('/media/logo.webp');
   expect(stylesheets).not.toContain('/_next/image');
   expect(readFileSync(join(root, images[0].path))).toEqual(webp);
   const html = readFileSync(join(root, 'website/index.html'), 'utf8');
   expect(html).not.toContain('/_next/image');
   expect(html).not.toContain(`${url}logo.webp`);
   expect(html).not.toContain('preview.webp');
   expect(html).toContain('src="/media/logo.webp"');
   expect(html).toContain('href="/media/logo.webp"');
   expect(html.replaceAll('&quot;', '"')).toMatch(/background-image:\s*url\(['"]?\/media\/logo.webp/);
   expect(html).toMatch(/rel="icon"[^>]*href="\/media\/logo.webp"/);
   expect(html).toMatch(/rel="apple-touch-icon"[^>]*href="\/media\/logo.webp"/);
   const diagnostics = JSON.parse(readFileSync(join(root, 'diagnostics.json'), 'utf8'));
   expect(diagnostics.unresolvedMedia).toEqual(expect.arrayContaining([expect.objectContaining({ url: `${url}missing.webp` })]));
   const findings = JSON.parse(readFileSync(join(root, 'website/source-findings.json'), 'utf8')).findings;
   expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'image_resource_unresolved', unit: 'asset', loss_class: 'omitted_unit', location: { url: `${url}missing.webp` } })]));
  } finally {

   rmSync(root, { recursive: true, force: true });
  }
 }, 120_000);
});

it('skips a site builder default icon but keeps an owner-uploaded one', () => {
 const custom = 'https://static.wixstatic.com/media/c168cb_c777%7Emv2.png/v1/fill/w_192%2Ch_192/c168cb_c777%7Emv2.png';
 const records = collectImageAssets([{ url: 'https://ellenbauer37.wixsite.com/my-site-2', html: `<link rel="icon" sizes="192x192" href="https://www.wix.com/favicon.ico"><link rel="shortcut icon" href="https://www.wix.com/favicon.ico"><link rel="apple-touch-icon" href="https://static.parastorage.com/client/pfavico.ico"><link rel="icon" href="${custom}">` }]);
 expect(records.map(record => record.resolved_original)).toEqual([custom]);
});
