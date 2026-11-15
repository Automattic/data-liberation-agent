import { load } from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml } from '../../lib/screenshot/screenshotter.js';
import { godaddyWmAdapter } from './index.js';

it('ports the GoDaddy marker independently of the Google view centre using scoped runtime props', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><div id="owner"><div data-aid="CONTACT_MAP_REND">
      <div class="gm-style" style="width:720px;height:360px"><a href="https://maps.google.com/maps?ll=51.49,-0.11&z=14&t=m">Open map</a></div>
    </div></div><script>
      // The source attaches its component's location props to the host fiber;
      // the map's Google link carries its independently movable viewport.
      const host=document.querySelector('[data-aid="CONTACT_MAP_REND"]');
      host.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:{type:'google',lat:'51.50012345',lon:'-0.12098765',zoom:14,address:'Neutral workshop'},return:null}};
    </script>`);
    await godaddyWmAdapter.liberation!.beforeSerialize!(page,{url:'https://example.test/contact',viewport:'desktop'});
    const captured = load(await capturePageHtml(page));
    expect(captured('iframe').attr('src')).toBe('https://maps.google.com/maps?ll=51.49%2C-0.11&z=14&t=m&q=51.50012345%2C-0.12098765&output=embed');
    expect(captured('[data-blocks-engine-capture-google-map-marker]')).toHaveLength(0);
  } finally {
    await browser.close();
  }
});

it('does not infer a marker from missing, invalid, cyclic or non-Google component evidence', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>${['missing','invalid','cyclic','other','outside'].map(id=>
      `<div id="${id}" ${id==='outside'?'':'data-aid="CONTACT_MAP_REND"'}><div class="gm-style" style="width:200px;height:100px"><a href="https://maps.google.com/maps?ll=1,2&z=5">Open map</a></div></div>`
    ).join('')}<script>
      document.getElementById('invalid').__reactFiber$fixture={memoizedProps:{type:'google',lat:'91',lon:'2'}};
      const cyclic={memoizedProps:{}};cyclic.return=cyclic;
      document.getElementById('cyclic').__reactFiber$fixture=cyclic;
      document.getElementById('other').__reactFiber$fixture={memoizedProps:{type:'bing',lat:'1',lon:'2'}};
      document.getElementById('outside').__reactFiber$fixture={memoizedProps:{type:'google',lat:'1',lon:'2'}};
    </script>`);
    await godaddyWmAdapter.liberation!.beforeSerialize!(page,{url:'https://example.test/contact',viewport:'desktop'});
    const captured = load(await capturePageHtml(page));
    expect(captured('iframe')).toHaveLength(5);
    for (const frame of captured('iframe').toArray()) {
      expect(captured(frame).attr('src')).toBe('https://maps.google.com/maps?ll=1%2C2&z=5&output=embed');
    }
  } finally {
    await browser.close();
  }
});
