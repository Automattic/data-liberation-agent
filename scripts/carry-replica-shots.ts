/**
 * Screenshot the LIVE carry site into a replica-dir matching the origin layout
 * (manifest.json + desktop/<slug>.png + mobile/<slug>.png) at the SAME device
 * scale as the source captures (desktop 1440@0.7, mobile 390@1.0), so
 * liberate_compare can join origin↔replica by pathname. Site-generic via argv.
 *
 * Navigation: maps each source pathname to the LOCAL permalink via redirect-map.json
 * (posts move /post/<slug> -> /<slug>/, which WP further 301s to its date permalink).
 * Navigating the bare source path would rely on WP's canonical-redirect guessing, which
 * is unreliable for long/%-encoded slugs — so we hit the redirect-map `to` directly and
 * let page.goto follow the 301 chain. The replica manifest stays keyed by the SOURCE url
 * so liberate_compare joins origin↔replica correctly.
 *
 *   npx tsx scripts/carry-replica-shots.ts <originDir> <carryBaseUrl> <replicaDir>
 */
import { chromium } from 'playwright';
import { shimNames } from './_pw.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [originDir, carryBaseUrl, replicaDir] = process.argv.slice(2);
if (!originDir || !carryBaseUrl || !replicaDir) {
  console.error('usage: tsx scripts/carry-replica-shots.ts <originDir> <carryBaseUrl> <replicaDir>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(originDir, 'screenshots/manifest.json'), 'utf8'));
const entries: Record<string, { slug?: string }> = manifest.entries || manifest;

// redirect-map: source pathname -> local permalink (so posts hit /<slug>/ not /post/<slug>)
const redirectTo = new Map<string, string>();
const rmPath = join(originDir, 'redirect-map.json');
if (existsSync(rmPath)) {
  const rm = JSON.parse(readFileSync(rmPath, 'utf8')) as Array<{ from: string; to: string }>;
  for (const r of rm) redirectTo.set(r.from.replace(/\/$/, ''), r.to);
}
const navFor = (pathname: string) => redirectTo.get(pathname.replace(/\/$/, '')) ?? pathname;

mkdirSync(join(replicaDir, 'desktop'), { recursive: true });
mkdirSync(join(replicaDir, 'mobile'), { recursive: true });

async function settle(page: import('playwright').Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
    const imgs = Array.from(document.images);
    const wait = Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : im.decode().catch(() => undefined))));
    await Promise.race([wait, new Promise((r) => setTimeout(r, 6000))]);
  });
  const hasFrame = await page.evaluate(() => !!document.querySelector('.lib-carry-mobile-frame'));
  await page.waitForTimeout(hasFrame ? 2500 : 400);
}

async function run() {
  const base = carryBaseUrl.replace(/\/$/, '');
  const browser = await chromium.launch();
  const replicaManifest: { version: number; entries: Record<string, unknown> } = { version: 1, entries: {} };
  let ok = 0, fail = 0;
  for (const [url, info] of Object.entries(entries)) {
    const slug = info.slug;
    if (!slug) continue;
    const pathname = new URL(url).pathname;
    const carryUrl = base + navFor(pathname);
    const files: Record<string, string> = { slug };
    const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    for (const [vp, scale, dir] of [
      [{ width: 1440, height: 900 }, 0.7, 'desktop'],
      [{ width: 390, height: 844 }, 1, 'mobile'],
    ] as const) {
      const ctx = await browser.newContext(
        dir === 'mobile'
          ? { viewport: vp, deviceScaleFactor: scale, isMobile: true, hasTouch: true, userAgent: MOBILE_UA }
          : { viewport: vp, deviceScaleFactor: scale },
      );
      const page = await ctx.newPage();
      await shimNames(page);
      try {
        await page.goto(carryUrl, { waitUntil: 'load', timeout: 40000 });
        await settle(page);
        const rel = `${dir}/${slug}.png`;
        await page.screenshot({ path: join(replicaDir, rel), fullPage: true });
        files[dir] = rel;
      } catch (e) {
        fail++;
        console.warn(`  fail ${dir} ${pathname}: ${(e as Error).message.slice(0, 60)}`);
      }
      await page.close();
      await ctx.close();
    }
    replicaManifest.entries[url] = files;
    ok++;
  }
  writeFileSync(join(replicaDir, 'manifest.json'), JSON.stringify(replicaManifest, null, 2));
  console.log(`captured ${ok} urls (${fail} viewport failures) -> ${replicaDir}`);
  await browser.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
