import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { startStaticServer, type StaticServer } from '../replicate/local-site/static-server.js';

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
.grid { display:grid; transition:grid-template-rows 300ms; }
.grid-rows-\\[0fr\\] { grid-template-rows:0fr; }
.grid-rows-\\[1fr\\] { grid-template-rows:1fr; }
.min-h-0 { min-height:0; } .overflow-hidden { overflow:hidden; }
.answer { height:180px; } button { height:40px; }
</style></head><body><main><h1>Sessions</h1>
<div id="filters">${['All', 'Alpha', 'Beta'].map((name, i) => `<label style="cursor:pointer"><input type="radio" name="filter" value="${i}" ${i === 0 ? 'checked' : ''}>${name}</label>`).join('')}</div>
<div id="cards"></div></main><script>
const cards = Array.from({length:4}, (_,i) => '<article><div><h3><button type="button" id="button-'+i+'" aria-expanded="false" aria-controls="panel-'+i+'">Session '+i+'</button></h3></div><div id="panel-'+i+'" role="region" aria-labelledby="button-'+i+'" aria-hidden="true" inert class="grid transition-[grid-template-rows] grid-rows-[0fr]"><div class="min-h-0 overflow-hidden"><div class="answer">Populated session details '+i+'</div></div></div></article>');
function render(value) { document.querySelector('#cards').innerHTML = cards.filter((_,i) => value === '0' || i % 2 === Number(value)-1).join(''); }
render('0');
document.querySelectorAll('input').forEach(input => input.addEventListener('change', () => render(input.value)));
document.querySelector('#cards').addEventListener('click', event => {
 const button = event.target.closest('button'); if (!button) return;
 const panel = document.getElementById(button.getAttribute('aria-controls'));
 const open = button.getAttribute('aria-expanded') !== 'true';
 button.setAttribute('aria-expanded', String(open)); panel.setAttribute('aria-hidden', String(!open)); panel.inert = !open;
 panel.classList.toggle('grid-rows-[0fr]', !open); panel.classList.toggle('grid-rows-[1fr]', open);
});
</script></body></html>`;

async function cards(page: Page) {
  return page.locator('article').evaluateAll(items => items.map(item => ({
    expanded: item.querySelector('button')!.getAttribute('aria-expanded'),
    height: item.querySelector('[role=region]')!.getBoundingClientRect().height,
  })));
}

it.skipIf(process.env.SKIP_BROWSER_TESTS)('keeps filterable grid disclosures closed through capture and replays open/close offline', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, {'content-type': 'text/html'}); response.end(fixture); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/`;
  mkdirSync('.tmp-test', {recursive:true});
  const directory = mkdtempSync(join(process.cwd(), '.tmp-test', 'grid-disclosures-'));
  const browser = await chromium.launch();
  let preview: StaticServer | undefined;
  try {
    const source = await browser.newPage();
    await source.goto(url);
    expect(await cards(source)).toEqual(Array(4).fill({expanded:'false', height:0}));
    const capture = await captureScreenshots({urls:[url], primaryUrl:url, outputDir:directory, concurrency:1, settleMs:0, learnFluid:false,
      observeSource: async page => {
        expect(await cards(page)).toEqual(Array(4).fill({expanded:'false', height:0}));
      },
    });
    expect(capture.failed).toBe(0);
    exportWebsiteCapture({outputDir:directory, sourceUrl:url, platform:'default', summary:{routesFailed:capture.failed}, failures:[]});
    const copy = await browser.newPage();
    preview = await startStaticServer(join(directory, 'website'));
    await copy.goto(`${preview.url}/`);
    expect(await cards(copy)).toEqual(Array(4).fill({expanded:'false', height:0}));
    const manifest = JSON.parse(readFileSync(capture.manifestPath, 'utf8'));
    const evidence = manifest.entries[url].interactions;
    expect(evidence.components.filter((state: {kind:string;status:string}) => state.kind === 'disclosure' && state.status === 'captured')).toHaveLength(4);
    for (const width of [390, 1440]) {
      await copy.setViewportSize({width, height:900});
      await copy.locator('#button-0').click();
      await expect.poll(async () => (await cards(copy))[0].height).toBe(180);
      expect(await copy.locator('#panel-0').getAttribute('aria-hidden')).toBe('false');
      expect(await copy.locator('#panel-0').getAttribute('inert')).toBeNull();
      await copy.locator('#button-0').click();
      await expect.poll(async () => (await cards(copy))[0]).toEqual({expanded:'false', height:0});
      expect(await copy.locator('#panel-0').getAttribute('aria-hidden')).toBe('true');
      expect(await copy.locator('#panel-0').getAttribute('inert')).not.toBeNull();
    }
  } finally {
    await preview?.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, {recursive:true, force:true});
  }
}, 120_000);
