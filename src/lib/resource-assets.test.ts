import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { captureAssets, collectAssets, resourceContentType } from './image-assets.js';
import { runWithTrustedOrigins } from './media-fetch/safe-fetch.js';

it('does not verify placeholders or unknown downloads from an extension or response header', () => {
 for (const kind of ['font', 'document', 'video'] as const) {
  expect(resourceContentType(Buffer.from('<html>missing</html>'), kind)).toBeUndefined();
  expect(resourceContentType(Buffer.from('wOF2'), kind)).toBeUndefined();
 }
});

it('verifies query variants before merging and rejects font format mismatches without image fallback', async () => {
 const font = readFileSync('test/fixtures/resource-assets/roboto-latin-400-normal.woff');
 const server = createServer((req, res) => {
  res.end(req.url!.startsWith('/font') ? font : Buffer.from(`%PDF-1.4\n${req.url!.includes('different') ? 'different' : 'same'}\n%%EOF`));
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 mkdirSync('.tmp-test', {recursive:true});
 const root = mkdtempSync(join(process.cwd(), '.tmp-test/resource-aliases-'));
 try {
  const records = await runWithTrustedOrigins([url], () => captureAssets(root, [{url, html:'<a href="/terms.pdf?a">A</a><a href="/terms.pdf?b">B</a><a href="/terms.pdf?different">C</a><style>@font-face{src:url(/font) format("woff2")}</style>'}]));
  expect(records).toHaveLength(3);
  expect(records.filter(r=>r.original)).toHaveLength(2);
  expect(records.find(r=>r.source_urls.length === 2)!.references).toHaveLength(2);
  expect(records.find(r=>r.kind === 'font')).toMatchObject({original:null, error:expect.stringContaining('declared format')});
 } finally {
  server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(root,{recursive:true,force:true});
 }
});

it('records downloads and video sources at their owning elements, not as image candidates', () => {
 const records = collectAssets([{url:'https://example.com/',html:'<a download href="/file">File</a><video src="/direct" poster="/poster"><source src="/alternate"></video>'}]);
 expect(records.map(r=>r.kind).sort()).toEqual(['document','image','video','video']);
 expect(records.find(r=>r.kind === 'document')!.references[0].location).toBe('download:0:href');
 expect(records.filter(r=>r.kind === 'video').every(r=>r.destination_owner === 'media-library')).toBe(true);
});

describe.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('non-image public capture fixture (~15s)', () => {
 it('keeps each font format/subset, unifies verified PDF query aliases and rewrites video and poster', async () => {
  const files = new Map<string, Buffer>();
  for (const subset of ['latin', 'greek']) for (const format of ['woff', 'woff2']) {
   const name = `roboto-${subset}-400-normal.${format}`;
   files.set(`/${name}`, readFileSync(join('test/fixtures/resource-assets', name)));
  }
  files.set('/download.zip', readFileSync('test/fixtures/resource-assets/download.zip'));
  files.set('/movie.webm', readFileSync('test/fixtures/resource-assets/movie.webm'));
  files.set('/poster.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  files.set('/terms.pdf', readFileSync('test/fixtures/resource-assets/terms.pdf'));
  let css = '';
  for (const [subset, range] of [['latin', 'U+0000-00FF'], ['greek', 'U+0370-03FF']]) {
   css += `@font-face{font-family:Fixture; font-weight:400;font-style:normal;unicode-range:${range};src:url('/roboto-${subset}-400-normal.woff2') format('woff2'),url('/roboto-${subset}-400-normal.woff') format('woff');}`;
  }
  css += "@font-face{font-family:Missing;src:url('/missing.woff2') format('woff2')}";
  const server = createServer((req, res) => {
   const path = new URL(req.url!, 'http://example.com').pathname;
   // Lying headers must not become verified content types.
   if (files.has(path)) { res.writeHead(200, {'content-type':'application/octet-stream'}); res.end(files.get(path)); }
   else if (path === '/fonts.css') { res.writeHead(200, {'content-type':'text/css'}); res.end(css); }
   else if (path === '/missing.woff2') { res.writeHead(200, {'content-type':'font/woff2'}); res.end('<html>not a font</html>'); }
   else { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><title>Resource fixture</title><link rel="stylesheet" href="/fonts.css"><h1 style="font-family:Fixture">Hello α</h1><nav><a href="/terms.pdf?download=1">Terms</a></nav><a href="/terms.pdf?download=2" download>Download terms</a><a download href="/download.zip">Archive</a><video controls poster="/poster.png"><source src="/movie.webm" type="video/webm"></video>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  mkdirSync('.tmp-test', {recursive:true});
  const root = mkdtempSync(join(process.cwd(), '.tmp-test/resource-assets-'));
  try {
   const result = await captureWebsite({url, outputDir:root, trustedOrigins:[url], learnFluid:false, routeLimit:1}, {findAdapter:()=>({id:'fixture', detect:()=>true, discover:async()=>({urls:[]})})});
   const records = JSON.parse(readFileSync(join(root, 'image-assets.json'), 'utf8')).images;
   expect(records).toHaveLength(9); // four fonts, PDF, ZIP, video, poster, unresolved font
   const receipt = JSON.parse(readFileSync(result.captureReceiptPath, 'utf8'));
   const assets = receipt.assets.filter((asset:any)=>asset.original);
   expect(assets).toHaveLength(8);
   const html = readFileSync(join(root, 'website/index.html'), 'utf8');
   const exportedCss = receipt.assets.filter((asset:any)=>asset.path.endsWith('.css')).map((asset:any)=>readFileSync(join(root, asset.path), 'utf8')).join('\n');
   for (const record of records.filter((r:any)=>r.original)) {
    const asset = assets.find((a:any)=>a.source_url === record.resolved_original);
    expect(asset).toBeDefined();
    expect(asset.references).toEqual(record.references);
    expect(asset.destination_owner).toBe(record.kind === 'font' ? 'theme' : 'media-library');
    const bytes = readFileSync(join(root, asset.path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.original.sha256);
    const sourcePath = new URL(record.resolved_original).pathname;
    expect(bytes).toEqual(files.get(sourcePath));
    if (sourcePath === '/movie.webm') expect(record.original.content_type).toBe('video/webm');
    if (sourcePath === '/download.zip') expect(record.original.content_type).toBe('application/zip');
    if (sourcePath === '/poster.png') expect(record.original.content_type).toBe('image/png');
    if (record.kind === 'font') {
     expect(record.original.content_type).toBe(sourcePath.endsWith('woff2') ? 'font/woff2' : 'font/woff');
     expect(exportedCss).toContain('/' + asset.path.replace('website/', ''));
     expect(record.references.every((ref:any)=>ref.kind === 'CSS')).toBe(true);
     expect(record.references[0].font_face).toMatchObject({family:'Fixture', weight:'400', style:'normal', unicode_range:sourcePath.includes('latin') ? 'U+0000-00FF' : 'U+0370-03FF', format:sourcePath.endsWith('woff2') ? 'woff2' : 'woff'});
    } else {
     expect(html).toContain('/' + asset.path.replace('website/', ''));
    }
    for (const source of record.source_urls) expect(html + exportedCss).not.toContain(source);
   }
   const pdf = records.find((r:any)=>r.original?.content_type === 'application/pdf');
   expect(pdf.source_urls).toHaveLength(2);
   expect(pdf.original.content_type).toBe('application/pdf');
   expect(new Set(pdf.references.map((ref:any)=>ref.kind))).toEqual(new Set(['navigation','content']));
   const pdfPath = '/' + assets.find((a:any)=>a.original?.content_type === 'application/pdf').path.replace('website/', '');
   expect(html.split(`href="${pdfPath}"`)).toHaveLength(3);
   expect(html).toMatch(/poster="\/media\/poster.png"/);
   expect(html).toMatch(/src="\/media\/movie.webm"/);
   expect(exportedCss).toContain('U+0000-00FF');
   expect(exportedCss).toContain('U+0370-03FF');
   expect(exportedCss).not.toContain('placeholder.svg');
   expect(exportedCss).not.toContain('data:image');
   expect(exportedCss).not.toContain('/missing.woff2');
   expect(exportedCss.match(/format\(['"]woff2['"]\)/g)).toHaveLength(2);
   expect(exportedCss.match(/format\(['"]woff['"]\)/g)).toHaveLength(2);
   const findings = JSON.parse(readFileSync(join(root,'website/source-findings.json'),'utf8')).findings;
   expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({code:'asset_resource_unresolved', unit:'asset', loss_class:'omitted_unit', location:{url:`${url}missing.woff2`}})]));
  } finally {
   server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
   rmSync(root,{recursive:true,force:true});
  }
 }, 120_000);
});
