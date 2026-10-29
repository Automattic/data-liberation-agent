import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { getPlaywright } from './browser-kit/index.js';
import { collectImageAssets, imageContentType, resolvedImageOriginal } from './image-assets.js';

it('resolves optimizer targets and chooses the largest srcset candidate independent of order', () => {
 const records = collectImageAssets([{ url: 'https://example.com/', html: '<img src="small.webp" srcset="large.webp 900w, small.webp 100w"><div style="background:url(small.webp)"></div>' }]);
 expect(records).toHaveLength(1);
 expect(records[0].resolved_original).toBe('https://example.com/large.webp');
 expect(records[0].source_urls).toEqual(expect.arrayContaining(['https://example.com/small.webp', 'https://example.com/large.webp']));
 expect(resolvedImageOriginal('https://example.com/_next/image?url=%2Flogo.webp&w=640&q=75')).toBe('https://example.com/logo.webp');
});

it('records extensionless CSS backgrounds with document bases but not font sources or video sources', () => {
 const records = collectImageAssets([{ url: 'https://example.com/page/', html: '<base href="/assets/"><style>@font-face{src:url(font-proxy?id=1)}.hero{background-image:url(image-proxy?id=2)}</style><video><source src="movie.mp4"></video><div style="background:url(&quot;image-proxy?id=2&quot;)"></div>' }]);
 expect(records).toHaveLength(1);
 expect(records[0].source_urls).toEqual(['https://example.com/assets/image-proxy?id=2']);
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
  const proxy = (w: number) => `/_next/image?url=%2Flogo.webp&w=${w}&q=75`;
  const server = createServer((request, response) => {
   const path = new URL(request.url!, 'http://example.com').pathname;
   // Deliberately lie about the format: metadata and filename must follow bytes.
   if (path === '/logo.webp') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(webp); }
   else if (path === '/_next/image') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(jpeg); }
   else if (path === '/missing.webp') { response.writeHead(200, { 'content-type': 'image/webp' }); response.end('<html>placeholder</html>'); }
   else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><title>Next image fixture</title><h1>Transparent logo</h1><img alt="Logo" src="${proxy(67)}" srcset="${proxy(203)} 203w, ${proxy(67)} 67w"><div style="width:203px;height:90px;background-image:url('${proxy(67)}')"></div><img alt="Missing" src="/missing.webp">`); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.tmp-test', 'next-image-'));
  try {
   const result = await captureWebsite({ url, outputDir: root, trustedOrigins: [url], learnFluid: false, routeLimit: 1 }, { findAdapter: () => ({ id: 'generic', discover: async () => ({ urls: [] }) }) });
   const records = JSON.parse(readFileSync(join(root, 'image-assets.json'), 'utf8')).images;
   expect(records).toHaveLength(2);
   const logo = records.find((r: any) => r.original);
   expect(logo.original).toMatchObject({ source_url: `${url}logo.webp`, content_type: 'image/webp', width: 203, height: 90, alpha: true });
   expect(logo.source_urls).toEqual(expect.arrayContaining([`${url}logo.webp`, new URL(proxy(67), url).href, new URL(proxy(203), url).href]));
   const receipt = JSON.parse(readFileSync(result.captureReceiptPath, 'utf8'));
   const images = receipt.assets.filter((asset: any) => asset.original);
   expect(images).toHaveLength(1);
   expect(images[0].source_url).toBe(`${url}logo.webp`);
   expect(readFileSync(join(root, images[0].path))).toEqual(webp);
   const html = readFileSync(join(root, 'website/index.html'), 'utf8');
   expect(html).not.toContain('/_next/image');
   expect(html).not.toContain(`${url}logo.webp`);
   expect(html).toContain('src="/media/logo.webp"');
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
