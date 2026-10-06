import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { expandCollapsedContent, hydrateDisclosureContent } from './dynamic-content.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';

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
