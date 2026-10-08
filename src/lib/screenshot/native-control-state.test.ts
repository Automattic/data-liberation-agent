import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml, captureScreenshots } from './screenshotter.js';
import { sanitizeFrozenHtml } from './freeze.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { createReferenceCollector } from '../fidelity/reference.js';
import { checkFidelity } from '../fidelity/check.js';
import { NATIVE_CONTROL_STATE_ATTRIBUTE, NATIVE_CONTROL_STATE_RUNTIME, wireNativeControlState } from '../native-control-state.js';
import { sanitizeSourceHtml } from '../streaming/html-sanitize.js';

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>label { font: 400 16px/24px sans-serif; color: black } input:checked + label { font-weight: 600 }
input:default + label { color: red } option { color: black } option:default { color: red } option:checked { font-weight: 600 }</style></head><body>
<form id="first">
<input id="on" type="checkbox"><label for="on">Selected filter</label>
<input id="off" type="checkbox" checked="checked"><label for="off">Unselected filter</label>
<input id="radio-a" type="radio" name="category" checked><label for="radio-a">First category</label>
<input id="radio-b" type="radio" name="category"><label for="radio-b">Second category</label>
<input id="text" value="authored"><input id="empty" value="authored"><input id="untouched">
<input id="number" type="number" value="1"><input id="file" type="file">
<textarea id="textarea">

authored text</textarea>
<select id="select"><optgroup label="Choices"><option selected>Alpha</option><option>Beta</option></optgroup></select>
<select id="multi" multiple><option selected>Alpha</option><option>Beta</option><option selected>Gamma</option></select>
<select id="none" multiple><option selected>Alpha</option><option>Beta</option></select>
<select id="single-none"><option selected>Alpha</option><option>Beta</option></select>
</form><form id="second"><input id="other-radio" type="radio" name="category" checked></form>
<script>
document.querySelector('#on').checked = true;
document.querySelector('#off').checked = false;
document.querySelector('#radio-b').checked = true;
document.querySelector('#text').value = 'observed <&" value';
document.querySelector('#empty').value = '';
document.querySelector('#number').value = '42';
document.querySelector('#textarea').value = '\\nobserved <& text\\nsecond line';
document.querySelector('#select').selectedIndex = 1;
document.querySelector('#multi').options[0].selected = false;
document.querySelector('#multi').options[1].selected = true;
document.querySelector('#none').selectedIndex = -1;
document.querySelector('#single-none').selectedIndex = -1;
</script></body></html>`;

function state(page: Page) {
  return page.evaluate(() => ({
    checked: Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox],input[type=radio]'), input => input.checked),
    weights: Array.from(document.querySelectorAll('label'), label => getComputedStyle(label).fontWeight),
    colors: Array.from(document.querySelectorAll('label'), label => getComputedStyle(label).color),
    inputDefaults: Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox],input[type=radio]'), input => ({checked: input.defaultChecked, predicate: input.matches(':default')})),
    values: Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]):not([type=radio]),textarea'), input => input.value),
    valueDefaults: Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]):not([type=radio]),textarea'), input => input.defaultValue),
    selected: Array.from(document.querySelectorAll('select'), select => ({ index: select.selectedIndex, options: Array.from(select.options, option => option.selected) })),
    optionDefaults: Array.from(document.querySelectorAll('option'), option => ({selected: option.defaultSelected, predicate: option.matches(':default'), color: getComputedStyle(option).color})),
  }));
}

function sourceDefaults(page: Page) {
  return page.evaluate(() => ({
    html: document.querySelector('body')!.innerHTML,
    defaults: Array.from(document.querySelectorAll('input,textarea,option'), control =>
      control instanceof HTMLOptionElement ? control.defaultSelected : control instanceof HTMLInputElement ? [control.defaultChecked, control.defaultValue] : (control as HTMLTextAreaElement).defaultValue),
  }));
}

it('replays observed native control properties and CSS without mutating source attributes, defaults or radio peers', async () => {
  const browser = await chromium.launch();
  try {
    const source = await browser.newPage();
    const copy = await browser.newPage();
    await source.setContent(fixture);
    const baseline = await state(source);
    const defaults = await sourceDefaults(source);
    expect(baseline.checked).toEqual([true, false, false, true, true]);
    expect(baseline.weights).toEqual(['600', '400', '400', '600']);
    expect(baseline.colors).toEqual(['rgb(0, 0, 0)', 'rgb(255, 0, 0)', 'rgb(255, 0, 0)', 'rgb(0, 0, 0)']);
    expect(baseline.selected).toEqual([
      {index: 1, options: [false, true]}, {index: 1, options: [false, true, true]}, {index: -1, options: [false, false]},
      {index: -1, options: [false, false]},
    ]);
    // Independent pre-fix reproduction: attribute-only HTML drops runtime state.
    await copy.setContent(sanitizeFrozenHtml(await source.content()));
    expect((await state(copy)).checked).toEqual([false, true, true, false, true]);
    expect((await state(copy)).weights).toEqual(['400', '600', '600', '400']);

    // Independent reproduction of the previous candidate's property-to-attribute
    // snapshot: it fixes :checked but corrupts :default and native reset.
    const conflated = await source.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('script').forEach(script => script.remove());
      document.querySelectorAll<HTMLInputElement>('input').forEach((input, index) => {
        const copy = clone.querySelectorAll('input')[index]!;
        if (input.type === 'checkbox' || input.type === 'radio') copy.toggleAttribute('checked', input.checked);
        else if (input.type !== 'file' && input.value !== input.defaultValue) copy.setAttribute('value', input.value);
      });
      document.querySelectorAll('option').forEach((option, index) => clone.querySelectorAll('option')[index]!.toggleAttribute('selected', option.selected));
      document.querySelectorAll('textarea').forEach((textarea, index) => { clone.querySelectorAll('textarea')[index]!.textContent = textarea.value; });
      return clone.outerHTML;
    });
    await copy.setContent(conflated);
    expect((await state(copy)).checked).toEqual(baseline.checked);
    expect((await state(copy)).colors).toEqual(['rgb(255, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(255, 0, 0)']);
    expect((await state(copy)).optionDefaults).not.toEqual(baseline.optionDefaults);
    await copy.evaluate(() => document.querySelector<HTMLFormElement>('#first')!.reset());
    expect((await state(copy)).checked).toEqual(baseline.checked);

    const html = await capturePageHtml(source);
    expect(await state(source)).toEqual(baseline);
    expect(await sourceDefaults(source)).toEqual(defaults);
    expect(await source.locator(`[${NATIVE_CONTROL_STATE_ATTRIBUTE}]`).count()).toBe(0);
    await copy.setContent(sanitizeFrozenHtml(html));
    expect(await copy.locator(`[${NATIVE_CONTROL_STATE_ATTRIBUTE}]`).count()).toBe(await source.locator('input,textarea,select').count());
    expect(await copy.locator('#untouched').getAttribute('value')).toBeNull();
    expect(await copy.locator('#on').getAttribute('checked')).toBeNull();
    expect(await copy.locator('#off').getAttribute('checked')).toBe('checked');
    expect(await copy.locator('#file').inputValue()).toBe('');
    for (const width of [390, 768, 1440]) {
      await source.setViewportSize({width, height: 900});
      await copy.setViewportSize({width, height: 900});
      for (const serialized of [sanitizeFrozenHtml(html), wireNativeControlState(sanitizeSourceHtml(html, {preserveEmptyComments: true}))]) {
        await copy.setContent(serialized);
        expect(await state(copy), `${width}px native baseline replay`).toEqual(baseline);
        expect((await copy.locator('label[for=on]').screenshot({caret: 'initial'})).equals(await source.locator('label[for=on]').screenshot({caret: 'initial'}))).toBe(true);
      }
    }
    // A native activation and restoration use the same baseline; serialization
    // must not silently alter reset defaults or change another radio's state.
    await source.locator('#on').click();
    await copy.setContent(sanitizeFrozenHtml(await capturePageHtml(source)));
    expect(await state(copy)).toEqual(await state(source));
    await source.locator('#on').click();
    expect(await capturePageHtml(source)).toBe(html);
    expect(await sourceDefaults(source)).toEqual(defaults);
    await source.locator('#textarea').evaluate(element => { (element as HTMLTextAreaElement).value = '\nleading newline'; });
    await copy.setContent(sanitizeFrozenHtml(await capturePageHtml(source)));
    expect(await copy.locator('#textarea').inputValue()).toBe('\nleading newline');
    expect(await sourceDefaults(source)).toEqual(defaults);
    await source.evaluate(() => document.querySelector<HTMLFormElement>('#first')!.reset());
    const reset = await state(source);
    expect(reset.checked).toEqual([false, true, true, false, true]);
    await copy.setContent(sanitizeFrozenHtml(html));
    await copy.evaluate(() => document.querySelector<HTMLFormElement>('#first')!.reset());
    expect(await state(copy)).toEqual(reset);
    expect(await sourceDefaults(source)).toEqual(defaults);
  } finally { await browser.close(); }
}, 30_000);

it('preserves the native baseline through screenshot capture, export and capture-session frozen verification', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, {'content-type': 'text/html'}); response.end(fixture); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/`;
  mkdirSync(join(process.cwd(), '.tmp-test'), {recursive: true});
  const directory = mkdtempSync(join(process.cwd(), '.tmp-test', 'native-control-state-618-'));
  let closed = false;
  const browser = await chromium.launch();
  try {
    const source = await browser.newPage();
    await source.goto(url);
    const baseline = await state(source);
    await source.evaluate(() => document.querySelector<HTMLFormElement>('#first')!.reset());
    const reset = await state(source);
    const collector = createReferenceCollector(directory, url, [url]);
    const capture = await captureScreenshots({urls: [url], primaryUrl: url, outputDir: directory, concurrency: 1, settleMs: 0, learnFluid: false,
      observeSource: async (...args) => {
        expect(await state(args[0])).toEqual(baseline);
        await collector.observe(...args);
      },
    });
    expect(capture.failed).toBe(0);
    expect(capture.captured).toBe(1);
    const receiptPath = exportWebsiteCapture({outputDir: directory, sourceUrl: url, platform: 'default', summary: {routesFailed: capture.failed}, failures: []});
    const reference = JSON.parse(readFileSync(collector.finalize(receiptPath), 'utf8'));
    expect(reference.scope.sourceUrls).toEqual([url]);
    const copy = await browser.newPage();
    const exportedHtml = readFileSync(join(directory, 'website', 'index.html'), 'utf8');
    expect(exportedHtml).not.toContain("document.querySelector('#on')");
    expect(exportedHtml).toContain(NATIVE_CONTROL_STATE_RUNTIME);
    expect(exportedHtml.match(/<script data-dla-native-control-runtime/g)).toHaveLength(1);
    await copy.setContent(exportedHtml);
    expect(await state(copy)).toEqual(baseline);
    await copy.evaluate(() => document.querySelector<HTMLFormElement>('#first')!.reset());
    expect(await state(copy)).toEqual(reset);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closed = true;
    const report = await checkFidelity({directory, widths: [390, 768, 1440]});
    expect(report.pass, JSON.stringify(report)).toBe(true);
    expect(report.pending).toHaveLength(0);
  } finally {
    await browser.close();
    if (!closed) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}, 180_000);

it('reconstructs only owned code after stripping forged scripts and rejects invalid typed property payloads', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const malicious = `<input type="checkbox" ${NATIVE_CONTROL_STATE_ATTRIBUTE}='{"version":1,"kind":"input","type":"checkbox","value":"on","defaultValue":"","checked":"true","defaultChecked":false,"indeterminate":false}'>
      <script data-dla-native-control-runtime>window.sourceExecuted=true</script><script>window.sourceExecuted=true</script>`;
    const clean = sanitizeFrozenHtml(malicious);
    expect(clean).not.toContain('window.sourceExecuted');
    expect(clean.match(/<script /g)).toHaveLength(1);
    await page.setContent(clean);
    expect(await page.evaluate(() => 'sourceExecuted' in window)).toBe(false);
    expect(await page.locator('input').isChecked()).toBe(false);
    expect(sanitizeFrozenHtml(clean)).toBe(clean);
    expect(sanitizeSourceHtml(clean)).not.toContain('<script');
  } finally { await browser.close(); }
});
