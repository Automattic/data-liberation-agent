import { describe, it, expect } from 'vitest';
import { sanitizeFrozenHtml } from './freeze.js';
import { load } from 'cheerio';

describe('sanitizeFrozenHtml', () => {
  it('keeps empty text-node boundaries while stripping every comment payload', () => {
    expect(sanitizeFrozenHtml('<p>one<!---->two<!-- source instructions -->three</p>'))
      .toBe('<p>one<!---->twothree</p>');
  });
  it('strips scripts but preserves <style> and inline style=', () => {
    const input = `<style>.h{color:red}</style><div style="color:blue" onclick="x()">hi<script>evil()</script></div>`;
    const out = sanitizeFrozenHtml(input);
    expect(out).toContain('<style>.h{color:red}</style>');   // CSS preserved
    expect(out).toContain('style="color:blue"');             // inline style preserved
    expect(out).not.toContain('<script>');                   // script removed
    expect(out).not.toContain('onclick');                    // handler removed
  });
  it('keeps only bounded HTTPS capture-attested iframe surfaces and rebuilds safe attributes', () => {
    const html = sanitizeFrozenHtml(`<main>
      <iframe src="https://source.test/wrong" class="map" title="Map" srcdoc="evil" onclick="evil()" data-blocks-engine-capture-visual-iframe-src="https://maps.example.test/embed" data-blocks-engine-capture-visual-iframe-width="640" data-blocks-engine-capture-visual-iframe-height="320"><script>evil()</script></iframe>
      <iframe src="https://unattested.test/embed" width="640" height="320"></iframe>
      <iframe src="https://source.test/wrong" data-blocks-engine-capture-visual-iframe-src="javascript:evil()" data-blocks-engine-capture-visual-iframe-width="640" data-blocks-engine-capture-visual-iframe-height="320"></iframe>
      <iframe src="https://source.test/wrong" data-blocks-engine-capture-visual-iframe-src="https://zero.test/embed" data-blocks-engine-capture-visual-iframe-width="640" data-blocks-engine-capture-visual-iframe-height="0"></iframe>
    </main>`);
    const $ = load(html);
    expect($('iframe')).toHaveLength(1);
    expect($('iframe').attr('src')).toBe('https://maps.example.test/embed');
    expect($('iframe').attr('width')).toBe('640');
    expect($('iframe').attr('height')).toBe('320');
    expect($('iframe').attr('title')).toBe('Map');
    expect($('iframe').attr('class')).toBe('map');
    expect($('iframe').attr('srcdoc')).toBeUndefined();
    expect($('iframe').attr('onclick')).toBeUndefined();
    expect($('iframe').html()).toBe('');
  });
});
