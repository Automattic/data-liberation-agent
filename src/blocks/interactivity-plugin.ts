// src/blocks/interactivity-plugin.ts
//
// Custom Interactivity-API blocks as DATA (spec §6, Plan A: reveal + sticky).
// buildInteractivityPlugin() returns a ReplicaBlockPlugin consumed by the
// existing writeReplicaFilesToHost plugin path + `wp plugin activate`.
//
// No build step (verified against WP 7.0 core): block.json viewScriptModule +
// hand-written ESM view.js. THE LOAD-BEARING DETAIL is view.asset.php — module
// dependencies come ONLY from that sibling file; without it the frontend
// import map omits @wordpress/interactivity and the bare import fails.
//
// Behavior params (IO threshold, animation, scroll offset) arrive via
// data-wp-context on the EMITTED MARKUP (emit-blocks/chrome-parts), not via
// these static files — one plugin serves every site.
//
import type { ReplicaBlockPlugin } from '../lib/preview/types.js';

export const PLUGIN_SLUG = 'dla-interactivity';

const PLUGIN_PHP = `<?php
/**
 * Plugin Name: DLA Interactivity Blocks
 * Description: Native Interactivity API blocks emitted by the data-liberation local-site converter (reveal, sticky).
 * Version: 1.0.0
 * Requires at least: 6.7
 */

defined( 'ABSPATH' ) || exit;

add_action( 'init', function () {
    register_block_type( __DIR__ . '/blocks/reveal' );
    register_block_type( __DIR__ . '/blocks/sticky' );
} );
`;

const VIEW_ASSET_PHP = `<?php return array( 'dependencies' => array( '@wordpress/interactivity' ), 'version' => '1.0.0' );
`;

const REVEAL_BLOCK_JSON =
  JSON.stringify(
    {
      $schema: 'https://schemas.wp.org/trunk/block.json',
      apiVersion: 3,
      name: 'dla/reveal',
      title: 'Reveal Section',
      category: 'design',
      description: 'Scroll-reveal section (IntersectionObserver via the Interactivity API).',
      supports: { interactivity: true, html: false },
      attributes: {
        anchor: { type: 'string' },
        className: { type: 'string' },
        threshold: { type: 'number', default: 0.12 },
        translateY: { type: 'string', default: '18px' },
        durationMs: { type: 'number', default: 600 },
      },
      viewScriptModule: 'file:./view.js',
      style: 'file:./style.css',
    },
    null,
    '\t',
  ) + '\n';

// The js-capability gate is a NAMESPACED class on <html> added by THIS module
// (dla-reveal-js) — never the source's bare "js" class, which would arm the
// dormant carried html.js rules against every <section> on the page. No-JS =>
// class absent => content visible (SSR-first, spec §6 a11y triad).
const REVEAL_VIEW_JS = `import { store, getContext, getElement } from '@wordpress/interactivity';

document.documentElement.classList.add( 'dla-reveal-js' );

store( 'dla/reveal', {
	callbacks: {
		init() {
			const ctx = getContext();
			const { ref } = getElement();
			if ( window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches ) {
				ctx.visible = true;
				return;
			}
			const obs = new IntersectionObserver(
				( entries ) => {
					entries.forEach( ( e ) => {
						if ( e.isIntersecting ) {
							ctx.visible = true;
							obs.unobserve( e.target );
						}
					} );
				},
				{ threshold: ctx.threshold ?? 0.12 }
			);
			obs.observe( ref );
		},
	},
} );
`;

// Hidden state is gated on .dla-reveal-js (module ran) AND :not(.is-visible).
// Animation params are the catalog defaults; per-site params ride the emitted
// markup's inline custom properties (--dla-reveal-y / --dla-reveal-ms).
//
// The transition rides the TARGET state (.is-visible) only: the gate class
// lands at MODULE time (post-first-paint — a block can't inject head-inline
// scripts the way the source site did), so a base-rule transition ANIMATED
// below-fold sections visible→hidden on gate arrival (a 600ms fade-OUT flash;
// probe caught opacity 0.0088 mid-fade). State-scoped, gate arrival snaps
// them hidden instantly, while the 0→1 reveal still animates because the
// transition is active on the state being ENTERED. Residual: a brief
// flash-of-visible BEFORE the module runs is unavoidable without a
// head-inline script — accepted v1 (matches the no-JS-resilient SSR-first
// posture: content is visible until JS proves it can reveal it).
const REVEAL_STYLE_CSS = `.dla-reveal-js .wp-block-dla-reveal:not(.is-visible) {
	opacity: 0;
	transform: translateY( var( --dla-reveal-y, 18px ) );
}
.dla-reveal-js .wp-block-dla-reveal.is-visible {
	transition: opacity var( --dla-reveal-ms, 600ms ) ease, transform var( --dla-reveal-ms, 600ms ) ease;
}
@media (prefers-reduced-motion: reduce) {
	.dla-reveal-js .wp-block-dla-reveal:not(.is-visible) {
		opacity: 1;
		transform: none;
	}
	.dla-reveal-js .wp-block-dla-reveal.is-visible {
		transition: none;
	}
}
`;

const STICKY_BLOCK_JSON =
  JSON.stringify(
    {
      $schema: 'https://schemas.wp.org/trunk/block.json',
      apiVersion: 3,
      name: 'dla/sticky',
      title: 'Sticky Header State',
      category: 'design',
      description: 'Scroll-reactive header state (toggles the source-authored class past an offset).',
      supports: { interactivity: true, html: false },
      attributes: {
        className: { type: 'string' },
        toggleClass: { type: 'string', default: 'is-scrolled' },
        offset: { type: 'number', default: 8 },
      },
      viewScriptModule: 'file:./view.js',
    },
    null,
    '\t',
  ) + '\n';

// The toggled class must land on the SAME element the source css targets
// (header.<class> rules in carried css). The block renders INSIDE the header
// template part, so it climbs to the nearest <header> — the part wrapper that
// source header{} rules already style (stage 1d). Falls back to its own ref
// when no header ancestor exists.
const STICKY_VIEW_JS = `import { store, getContext, getElement } from '@wordpress/interactivity';

store( 'dla/sticky', {
	callbacks: {
		init() {
			const ctx = getContext();
			const { ref } = getElement();
			const target = ref.closest( 'header' ) ?? ref;
			const toggleClass = ctx.toggleClass ?? 'is-scrolled';
			const offset = ctx.offset ?? 8;
			const apply = () => target.classList.toggle( toggleClass, window.scrollY > offset );
			apply();
			window.addEventListener( 'scroll', apply, { passive: true } );
		},
	},
} );
`;

export function buildInteractivityPlugin(): ReplicaBlockPlugin {
  return {
    slug: PLUGIN_SLUG,
    files: [
      { relativePath: 'plugin.php', content: PLUGIN_PHP },
      { relativePath: 'blocks/reveal/block.json', content: REVEAL_BLOCK_JSON },
      { relativePath: 'blocks/reveal/view.js', content: REVEAL_VIEW_JS },
      { relativePath: 'blocks/reveal/view.asset.php', content: VIEW_ASSET_PHP },
      { relativePath: 'blocks/reveal/style.css', content: REVEAL_STYLE_CSS },
      { relativePath: 'blocks/sticky/block.json', content: STICKY_BLOCK_JSON },
      { relativePath: 'blocks/sticky/view.js', content: STICKY_VIEW_JS },
      { relativePath: 'blocks/sticky/view.asset.php', content: VIEW_ASSET_PHP },
    ],
  };
}
