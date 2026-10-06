import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { expandCollapsedContent, hydrateDisclosureContent } from './dynamic-content.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { startStaticServer, type StaticServer } from '../replicate/local-site/static-server.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());
const fixture = `<!doctype html><html><head><style>
  body { margin:0 } header { padding:20px } nav > div { display:none }
  nav[data-open] > div { display:block } nav ul { margin:0; padding:0; list-style:none }
  nav li { height:110px } main { height:1000px } footer { height:100px }
  @media(min-width:1000px) { #menu { display:none } nav > div { display:block } nav li { height:30px } }
</style></head><body><header><nav>
  <button id="menu" type="button" aria-expanded="false" aria-controls="links">Menu</button>
  <div><ul id="links"><li><a href="#content">First</a></li><li><a href="#content">Second</a></li>
  <li><a href="#content">Third</a></li><li><a href="#content">Fourth</a></li>
  <li><a href="#content">Fifth</a></li><li><a href="#content">Sixth</a></li><li><a href="#content">Last</a></li></ul></div>
</nav></header><div><main id="content"><h1>Page content</h1>
  <button id="question" type="button" aria-expanded="false" aria-controls="answer">Question?</button>
  <div id="answer" role="region" hidden>Real expandable content</div>
</main><footer><a href="#content">Back to content</a></footer></div>
<script>
  menu.onclick=()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));document.querySelector('nav').toggleAttribute('data-open',open)};
  question.onclick=()=>{question.setAttribute('aria-expanded','true');answer.hidden=false};
</script></body></html>`;

for (const viewport of [{width:390,height:844},{width:402,height:681},{width:1440,height:900}]) {
  it.skipIf(skipBrowser)(`preserves navigation through baseline, probe and offline export at ${viewport.width}x${viewport.height}`, async () => {
    const browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport});
    try {
      await page.setContent(fixture);
      const top = await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top);
      await expandCollapsedContent(page);
      await hydrateDisclosureContent(page);
      expect(await page.locator('#answer').isVisible()).toBe(true);
      expect(await page.locator('#menu').getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top)).toBe(top);
      const baseline = (await page.content()).replace(/<script>[\s\S]*?<\/script>/g,'');
      const report = await captureTriggeredDialogs(page,'https://navigation.test/');
      const states = report.states.filter(state=>state.status==='captured');
      if (viewport.width < 1000) {
        expect(states).toHaveLength(1);
        expect(states[0]!.dialog!.html).toContain('id="links"');
        expect(states[0]!.dialog!.html).not.toContain('id="content"');
        expect(await page.locator('#menu').getAttribute('aria-expanded')).toBe('false');
      } else expect(states).toHaveLength(0);
      // Repeated observations still materialize the existing authored panel once.
      const portable = wireCapturedDialogs(baseline,[...report.states,...report.states]);
      await page.setContent(portable);
      const uniqueIds = async () => page.evaluate(()=>{
        const ids=Array.from(document.querySelectorAll('[id]'),el=>el.id);
        return ids.length===new Set(ids).size;
      });
      expect(await uniqueIds()).toBe(true);
      expect(await page.locator('#content').count()).toBe(1);
      expect(await page.locator('#links').count()).toBe(1);
      expect(await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top)).toBe(top);
      if (viewport.width < 1000) {
        const control = page.locator('#menu');
        const panelId = await control.getAttribute('aria-controls');
        expect(await page.locator(`[id="${panelId}"]`).count()).toBe(1);
        expect(await page.locator('#links').isVisible()).toBe(false);
        await control.click();
        expect(await control.getAttribute('aria-expanded')).toBe('true');
        expect(await page.locator('#links').isVisible()).toBe(true);
        expect(await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top)).toBeGreaterThan(top+700);
        await control.click();
        expect(await control.getAttribute('aria-expanded')).toBe('false');
        expect(await page.locator('#links').isVisible()).toBe(false);
        await control.focus();
        await page.keyboard.press('Enter');
        expect(await page.locator('#links').isVisible()).toBe(true);
        await page.keyboard.press('Escape');
        expect(await control.getAttribute('aria-expanded')).toBe('false');
        expect(await uniqueIds()).toBe(true);
        expect(await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top)).toBe(top);
      } else expect(await page.locator('#links').isVisible()).toBe(true);
    } finally { await browser.close(); }
  },30000);
}

it.skipIf(skipBrowser)('probes an opening transition and restores an initially expanded navigation', async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:390,height:844}});
  try {
    await page.setContent(fixture);
    await page.locator('#menu').click();
    const top = await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top);
    const report = await captureTriggeredDialogs(page,'https://navigation.test/');
    const state = report.states.find(state=>state.trigger.id==='menu');
    expect(state?.status).toBe('captured');
    expect(state?.dialog?.html).toContain('id="links"');
    expect(state?.dialog?.html).not.toContain('id="content"');
    expect(await page.locator('#menu').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#content').evaluate(el=>el.getBoundingClientRect().top)).toBe(top);
  } finally { await browser.close(); }
},30000);

for (const breakpoint of [650,1100]) {
  it.skipIf(skipBrowser)(`replays phone evidence on one responsive export using authored visibility at ${breakpoint}px`, async () => {
    const browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:390,height:844}});
    mkdirSync('.tmp-test',{recursive:true});
    const outputDir=mkdtempSync(join('.tmp-test','nav-responsive-'));
    let server: StaticServer | undefined;
    const responsive = fixture.replace('@media(min-width:1000px)',`@media(min-width:${breakpoint}px)`)
      .replace('nav ul { margin:0;', 'nav[data-open] ul { display:block } nav ul { display:none; margin:0;')
      .replace('nav > div { display:block } nav li { height:30px }',
        'nav > div { display:grid; grid-template-columns:1fr } nav ul { display:flex; gap:8px } nav li { height:30px }')
      .replace('<div><ul id="links">','<div style="border-top:3px solid"><ul id="links">');
    const measure = () => page.evaluate(()=>({
      links:Array.from(document.querySelectorAll('#links a'),el=>{
        const rect=el.getBoundingClientRect();
        return {text:el.textContent,x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      }),
      contentTop:document.querySelector('#content')!.getBoundingClientRect().top,
      menuDisplay:getComputedStyle(document.querySelector('#links')!).display,
      panelDisplay:getComputedStyle(document.querySelector('#links')!.parentElement!).display,
    }));
    try {
      await page.setContent(responsive);
      await expandCollapsedContent(page);
      await hydrateDisclosureContent(page);
      const baseline=(await page.content()).replace(/<script>[\s\S]*?<\/script>/g,'');
      const report=await captureTriggeredDialogs(page,'https://navigation.test/');
      expect(report.states.filter(state=>state.status==='captured')).toHaveLength(1);
      const sourceGeometry=new Map<number,Awaited<ReturnType<typeof measure>>>();
      for (const width of [390,768,1440]) {
        await page.setViewportSize({width,height:844});
        sourceGeometry.set(width,await measure());
      }
      // The same phone observation is applied once to a single document, then
      // served at every viewport, as in a collapsed-equivalent site export.
      for (const directory of ['html','html-mobile','screenshots']) mkdirSync(join(outputDir,directory));
      writeFileSync(join(outputDir,'html/home.html'),baseline);
      writeFileSync(join(outputDir,'html-mobile/home.html'),baseline);
      writeFileSync(join(outputDir,'screenshots/manifest.json'),JSON.stringify({version:1,entries:{
        'https://navigation.test/':{html:'html/home.html',mobileHtml:'html-mobile/home.html',interactions:report},
      }}));
      exportWebsiteCapture({outputDir,sourceUrl:'https://navigation.test/',platform:'generic',summary:{},failures:[]});
      const receipt=JSON.parse(readFileSync(join(outputDir,'capture-receipt.json'),'utf8'));
      expect(receipt.routes[0].responsiveVariants).toMatchObject({variants:1,outcome:'collapsed-equivalent'});
      server=await startStaticServer(join(outputDir,'website'));
      await page.goto(server.url);
      for (const width of [390,768,1440,390]) {
        await page.setViewportSize({width,height:844});
        await page.waitForTimeout(100);
        expect(await measure()).toEqual(sourceGeometry.get(width));
        expect(await page.locator('#links').count()).toBe(1);
        expect(await page.locator('#content').count()).toBe(1);
        if (await page.locator('#menu').isVisible()) {
          expect(await page.locator('#links').isVisible()).toBe(false);
          await page.locator('#menu').click();
          expect(await page.locator('#menu').getAttribute('aria-expanded')).toBe('true');
          expect(await page.getByRole('link',{name:'First',exact:true}).isVisible()).toBe(true);
          await page.keyboard.press('Escape');
          expect(await page.locator('#menu').getAttribute('aria-expanded')).toBe('false');
          expect(await measure()).toEqual(sourceGeometry.get(width));
        } else {
          expect(await page.getByRole('link',{name:'First',exact:true}).isVisible()).toBe(true);
          expect(await page.getByRole('link',{name:'Last',exact:true}).isVisible()).toBe(true);
        }
      }
      // A resize from an open phone menu also hands layout back to source CSS.
      await page.locator('#menu').click();
      await page.setViewportSize({width:1440,height:844});
      await page.waitForTimeout(100);
      expect(await measure()).toEqual(sourceGeometry.get(1440));
      expect(await page.evaluate(()=>{
        const ids=Array.from(document.querySelectorAll('[id]'),el=>el.id);
        return new Set(ids).size===ids.length;
      })).toBe(true);
    } finally {
      await browser.close();
      await server?.close();
      rmSync(outputDir,{recursive:true,force:true});
    }
  },30000);
}

it.skipIf(skipBrowser)('does not mistake unowned flow displacement for a movement-only popup', async () => {
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:402,height:681}});
  try {
    await page.setContent(`<!doctype html><body style="margin:0"><header><button id="menu">Menu</button></header>
      <div id="spacer" style="height:900px"></div><div><main id="content" style="height:600px">Body</main><footer><a href="#content">Footer link</a></footer></div>
      <script>menu.onclick=()=>spacer.remove()</script></body>`);
    const report = await captureTriggeredDialogs(page,'https://navigation.test/');
    expect(report.states.find(state=>state.trigger.id==='menu')?.status).toBe('no-dialog');
    expect(report.states.some(state=>state.dialog?.html.includes('id="content"'))).toBe(false);
  } finally { await browser.close(); }
},30000);
