import {chromium} from 'playwright';
import {expect, it} from 'vitest';
import {hydrateDisclosureContent} from './dynamic-content.js';
import {captureSelectableSetStates} from './selectable-set-capture.js';
import {wireCapturedDialogs} from '../static-dialogs.js';

it('captures rebuilt category answers by observation, including different answers with duplicate labels', async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  try {
    await page.setContent(`<main><div id="picker">
      <button type="button" aria-selected="true">All</button>
      <button type="button" aria-selected="false">Alpha</button>
      <button type="button" aria-selected="false">Beta</button>
      </div><section id="items"></section></main><script>
      const items = [
        {question:'Shared question', answer:'First distinctly observed answer.', category:'Alpha'},
        {question:'Shared question', answer:'Second independently observed answer.', category:'Alpha'},
        {question:'Third question', answer:'Third answer with its complete content.', category:'Beta'},
        {question:'Fourth question', answer:'Fourth answer with its complete content.', category:'Beta'}
      ];
      function render(category) {
        document.getElementById('items').innerHTML = items.filter(item => category === 'All' || item.category === category).map(item =>
          '<article><button type="button" aria-expanded="false">' + item.question + '</button></article>').join('');
        document.querySelectorAll('#items button').forEach((button,index) => {
          const item = items.filter(item => category === 'All' || item.category === category)[index];
          button.onclick = () => {
            const open = button.getAttribute('aria-expanded') === 'false';
            button.setAttribute('aria-expanded', String(open));
            button.nextElementSibling?.remove();
            if(open) {const answer = document.createElement('div'); answer.textContent = item.answer; button.after(answer);}
          };
        });
        document.querySelectorAll('#picker button').forEach(button => button.setAttribute('aria-selected',String(button.textContent === category)));
      }
      document.querySelectorAll('#picker button').forEach(button => button.onclick = () => render(button.textContent));
      render('All');
      </script>`);
    await hydrateDisclosureContent(page);
    const states = await captureSelectableSetStates(page, {settleMs: 20});
    const captured = states.filter(state => state.status === 'captured' && state.kind === 'selectable-set');
    expect(captured).toHaveLength(3);
    const alpha = captured.find(state => state.trigger.label === 'Alpha')!;
    expect(alpha.dialog?.html).toContain('First distinctly observed answer.');
    expect(alpha.dialog?.html).toContain('Second independently observed answer.');
    expect(alpha.dialog?.html.match(/data-dla-local-disclosure/g)).toHaveLength(2);
    expect(await page.locator('#picker button[aria-selected="true"]').innerText()).toBe('All');
    expect(await page.locator('#items article').count()).toBe(4);
    expect(await page.locator('#items button[aria-expanded="true"]').count()).toBe(0);
  } finally {
    await browser.close();
  }
});

it('preserves an observed disclosure icon state without replacing the editable label', async () => {
  const browser=await chromium.launch({headless:true});const page=await browser.newPage();
  try {
    await page.setContent(`<style>.resting{rotate:0deg}.expanded{rotate:180deg}</style><article><button type="button" aria-expanded="false"><span>Editable question</span><svg class="resting" width="18" height="18" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button></article><script>const button=document.querySelector('button');button.onclick=()=>{const open=button.getAttribute('aria-expanded')==='false';button.setAttribute('aria-expanded',String(open));button.querySelector('svg').setAttribute('class',open?'expanded':'resting');button.nextElementSibling?.remove();if(open)button.insertAdjacentHTML('afterend','<div><p>Real answer</p></div>');};</script>`);
    const states=await hydrateDisclosureContent(page);
    expect(await page.locator('svg').getAttribute('class')).toBe('resting');
    expect(await page.locator('svg').getAttribute('data-dla-disclosure-open-class')).toBe('expanded');
    await page.setContent(wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g,''),states));
    await page.locator('button span').evaluate(element=>element.textContent='Owner edited question');
    await page.locator('button').click();expect(await page.locator('svg').getAttribute('class')).toBe('expanded');
    expect(await page.locator('svg').evaluate(element=>getComputedStyle(element).rotate)).toBe('180deg');
    expect(await page.locator('button span').innerText()).toBe('Owner edited question');
    await page.locator('button').click();expect(await page.locator('svg').getAttribute('class')).toBe('resting');
  } finally { await browser.close(); }
});
