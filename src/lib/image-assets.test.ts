import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { nextjsAdapter } from '../adapters/nextjs/index.js';
import { getPlaywright } from './browser-kit/index.js';
import { captureAssets, collectAssets as collectImageAssets, imageContentType, resolvedImageOriginal } from './image-assets.js';
import { AssetAcquisitionQueue } from './asset-acquisition-queue.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';
import { downloadCaptureSectionMedia } from './capture.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';

it('chooses the largest srcset candidate and delegates optimizer resolution to the adapter', () => {
 const records = collectImageAssets([{ url: 'https://example.com/', html: '<img src="small.webp" srcset="large.webp 900w, small.webp 100w"><div style="background:url(small.webp)"></div>' }]);
 expect(records).toHaveLength(1);
 expect(records[0].resolved_original).toBe('https://example.com/large.webp');
 expect(records[0].source_urls).toEqual(expect.arrayContaining(['https://example.com/small.webp', 'https://example.com/large.webp']));
 expect(resolvedImageOriginal('https://example.com/_next/image?url=%2Flogo.webp&w=640&q=75', nextjsAdapter.resolveImageOriginal)).toBe('https://example.com/logo.webp');
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
 it('admits locally captured bytes after the deadline but records new downloads as deadline-skipped', async () => {
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'image-deadline-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';
  try {
   mkdirSync(join(root, 'resources'), { recursive: true });
   writeFileSync(join(root, 'resources/logo.svg'), svg);
   writeFileSync(join(root, 'resources/manifest.json'), JSON.stringify({ version: 1, resources: {
    'https://example.com/logo.svg': { path: 'resources/logo.svg', contentType: 'image/svg+xml' },
   }, failures: [] }));
   const records = await captureAssets(root, [{ url: 'https://example.com/', html: '<img src="/logo.svg"><img src="/uncaptured.svg">' }], Date.now() - 1000);
   const local = records.find(record => record.resolved_original.endsWith('/logo.svg'))!;
   expect(local.original).toMatchObject({ content_type: 'image/svg+xml', width: 20, height: 10 });
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

 it('fetches a captured route\'s lightbox original before the deadline so assets admit it afterwards', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
  let hits = 0;
  const server = createServer((request, response) => { hits++; response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'asset-queue-'));
  try {
   const html = '<a href="/full.svg"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></a>';
   mkdirSync(join(root, 'html'), { recursive: true });
   writeFileSync(join(root, 'html/index.html'), html);
   await runWithTrustedOrigins([url], async () => {
    // Routes finish inside the budget; the asset stage starts after it.
    const queue = new AssetAcquisitionQueue(root, new SourceRequestGovernors(), Date.now() + 60_000);
    queue.enqueueRoute(url, ['html/index.html', 'html/index.html']);
    await queue.drain();
    const [record] = await captureAssets(root, [{ url, html }], Date.now() - 1000);
    expect(record.resolved_original).toBe(`${url}full.svg`);
    expect(record.error).toBeUndefined();
    expect(record.original).toMatchObject({ width: 40, height: 20 });
   });
   expect(hits).toBe(1);
  } finally {
   server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
   rmSync(root, { recursive: true, force: true });
  }
 });

 it('keeps a verified original when later section media shares its filename', async () => {
  const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"><rect width="${width}" height="10"/></svg>`;
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg(request.url!.startsWith('/large/') ? 40 : 20)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
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
   server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
   rmSync(root, { recursive: true, force: true });
  }
 });

 it('exports one alpha-preserving original with every srcset/proxy/CSS URL and flags unresolved images', async () => {
  const pw = await getPlaywright(), browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const data = await page.evaluate(() => {
   const c = document.createElement('canvas'); c.width = 203; c.height = 90;
   c.getContext('2d')!.fillRect(0, 0, 100, 90);
   return { webp: c.toDataURL('image/webp').split(',')[1], jpeg: c.toDataURL('image/jpeg').split(',')[1] };
  });
  await browser.close();
  const webp = Buffer.from(data.webp, 'base64'), jpeg = Buffer.from(data.jpeg, 'base64');
  const proxy = (w: number) => `/_next/image?url=%2Fpreview.webp&w=${w}&q=75`;
  const server = createServer((request, response) => {
   const path = new URL(request.url!, 'http://example.com').pathname;
   // Deliberately lie about the format: metadata and filename must follow bytes.
   if (path === '/logo.webp') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(webp); }
   else if (path === '/_next/image' || path === '/preview.webp') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(jpeg); }
   else if (path === '/hero.css') { response.writeHead(200, { 'content-type': 'text/css' }); response.end(`.hero{background-image:url('${proxy(203)}')}`); }
   else if (path === '/missing.webp') { response.writeHead(200, { 'content-type': 'image/webp' }); response.end('<html>placeholder</html>'); }
   else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><title>Next image fixture</title><link rel="stylesheet" href="/hero.css"><link rel="icon" href="${proxy(67)}"><link rel="apple-touch-icon" href="/logo.webp"><h1>Transparent logo</h1><nav><a href="/logo.webp"><img alt="Logo" src="${proxy(67)}" srcset="${proxy(203)} 203w, ${proxy(67)} 67w"></a></nav><img alt="Content logo" src="${proxy(67)}"><div class="hero" style="width:203px;height:90px;background-image:url('${proxy(67)}')"></div><img alt="Missing" src="/missing.webp">`); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
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
   server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
   rmSync(root, { recursive: true, force: true });
  }
 }, 120_000);
});
