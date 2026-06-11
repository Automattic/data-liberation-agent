import { describe, expect, it } from 'vitest';
import { buildInteractivityPlugin, PLUGIN_SLUG } from './interactivity-plugin.js';

const byPath = (files: Array<{ relativePath: string; content: string }>) =>
  Object.fromEntries(files.map((f) => [f.relativePath, f.content]));

describe('buildInteractivityPlugin', () => {
  it('emits the full file set for both blocks', () => {
    const plugin = buildInteractivityPlugin();
    expect(plugin.slug).toBe(PLUGIN_SLUG);
    const paths = plugin.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual([
      'blocks/reveal/block.json',
      'blocks/reveal/style.css',
      'blocks/reveal/view.asset.php',
      'blocks/reveal/view.js',
      'blocks/sticky/block.json',
      'blocks/sticky/view.asset.php',
      'blocks/sticky/view.js',
      'plugin.php',
    ]);
  });

  it('plugin.php registers both block dirs and nothing else dynamic', () => {
    const php = byPath(buildInteractivityPlugin().files)['plugin.php'];
    expect(php).toContain(`register_block_type( __DIR__ . '/blocks/reveal' )`);
    expect(php).toContain(`register_block_type( __DIR__ . '/blocks/sticky' )`);
    expect(php).toContain('Plugin Name:');
  });

  it('block.json declares interactivity support + viewScriptModule + style', () => {
    const files = byPath(buildInteractivityPlugin().files);
    const reveal = JSON.parse(files['blocks/reveal/block.json']);
    expect(reveal.name).toBe('dla/reveal');
    expect(reveal.supports.interactivity).toBe(true);
    expect(reveal.viewScriptModule).toBe('file:./view.js');
    expect(reveal.style).toBe('file:./style.css');
    const sticky = JSON.parse(files['blocks/sticky/block.json']);
    expect(sticky.name).toBe('dla/sticky');
    expect(sticky.supports.interactivity).toBe(true);
  });

  it('view.asset.php declares the interactivity module dependency (import-map requirement)', () => {
    const files = byPath(buildInteractivityPlugin().files);
    for (const p of ['blocks/reveal/view.asset.php', 'blocks/sticky/view.asset.php']) {
      expect(files[p]).toContain(`'dependencies' => array( '@wordpress/interactivity' )`);
    }
  });

  it('reveal view.js: store namespace, IO from context, is-visible class, no html.js global', () => {
    const js = byPath(buildInteractivityPlugin().files)['blocks/reveal/view.js'];
    expect(js).toContain(`store( 'dla/reveal'`);
    expect(js).toContain('IntersectionObserver');
    expect(js).toContain('getContext');
    expect(js).not.toContain(`classList.add('js')`);
    expect(js).not.toContain(`documentElement.classList.add( 'js' )`);
  });

  it('reveal style.css: scoped gate class, reduced-motion guard, no bare section selector', () => {
    const css = byPath(buildInteractivityPlugin().files)['blocks/reveal/style.css'];
    expect(css).toContain('.dla-reveal-js .wp-block-dla-reveal:not(.is-visible)');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).not.toMatch(/(^|[\s,{])section[\s.,{:]/);
  });

  it('sticky view.js toggles the configured class on the closest header', () => {
    const js = byPath(buildInteractivityPlugin().files)['blocks/sticky/view.js'];
    expect(js).toContain(`store( 'dla/sticky'`);
    expect(js).toContain(`closest( 'header' )`);
    expect(js).toContain('scrollY');
  });

  it('is deterministic — two builds emit identical bytes', () => {
    const a = buildInteractivityPlugin();
    const b = buildInteractivityPlugin();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
