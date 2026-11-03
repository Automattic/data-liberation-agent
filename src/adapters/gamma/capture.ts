// src/adapters/gamma/capture.ts
//
// A published Gamma site is a read-only Tiptap/ProseMirror document rendered
// by Next.js. Two things only work while Gamma's runtime is running:
//
// - Section links. Menu links point at `#card-<id>`, but no element carries
//   that id. The card is `<div class="card-wrapper" data-card-id="<id>"
//   data-card-scroll-element="true">`, and Gamma's click handler scrolls to it.
//   Each card a link on this page names gets that id, so a plain fragment link
//   lands on it. Unlinked cards get none: the phone document's nav links fewer
//   cards, and an id it never links would duplicate the desktop copy's target.
//
// - Videos. A video node (`.node-video`) shows a "Loading..." spinner and only
//   mounts its player once the runtime sees it in view, which a headless
//   capture does not reliably trigger. The published document in
//   `__NEXT_DATA__` (`props.pageProps.page.publishedSnapshot.content.default`)
//   holds every video node in document order, with the provider's embed URL
//   (`attrs.embed.url`, e.g. `https://www.youtube.com/embed/<id>`). Each video
//   node is replaced by a plain iframe of that URL. The pairing is by order and
//   is only made when the rendered and published video counts agree.
//
// - Toggles. A toggle node (`.node-toggle`) is a `.toggle[data-open]` box whose
//   first child is the summary; Gamma's stylesheet hides every later child while
//   `data-open="false"`, and its button only flips that attribute. No ARIA ties
//   the button to the content, so capture sees no disclosure and the copy keeps
//   the content hidden for good. Each toggle becomes a native `<details>` with
//   the summary text and copies of the content, which works without a runtime.
//   Inner toggles go first, so a parent copies its already-converted children.

import type { Page } from 'playwright';

export async function prepareGammaPage( page: Page ): Promise< void > {
	await page.evaluate( () => {
		const linked = new Set< string >();
		for ( const link of document.querySelectorAll< HTMLAnchorElement >( 'a[href*="#card-"]' ) ) {
			try {
				const url = new URL( link.href );
				if ( url.origin === location.origin && url.pathname === location.pathname ) linked.add( decodeURIComponent( url.hash.slice( 1 ) ) );
			} catch { /* not a usable link */ }
		}
		for ( const card of document.querySelectorAll< HTMLElement >( '[data-card-id][data-card-scroll-element="true"]' ) ) {
			const id = `card-${ card.dataset.cardId }`;
			if ( linked.has( id ) && ! card.id && ! document.getElementById( id ) ) card.id = id;
		}

		for ( const toggle of [ ...document.querySelectorAll< HTMLElement >( '.node-toggle' ) ].reverse() ) {
			const view = toggle.querySelector( ':scope > [data-node-view-wrapper]' );
			const box = view?.querySelector< HTMLElement >( '.toggle[data-open]' );
			const content = box?.querySelector( '[data-node-view-content-inner="toggle"]' );
			const title = content?.firstElementChild?.querySelector( '[data-node-view-content-inner="toggleSummary"]' );
			if ( ! view || ! box || ! content || ! title ) continue;
			const details = document.createElement( 'details' );
			details.className = box.className;
			details.open = box.dataset.open === 'true';
			const summary = document.createElement( 'summary' );
			summary.append( ...[ ...title.childNodes ].map( ( node ) => node.cloneNode( true ) ) );
			details.append( summary, ...[ ...content.children ].slice( 1 ).map( ( node ) => node.cloneNode( true ) ) );
			// Like the video swap below: detach Gamma's node view, so a later render
			// updates the detached subtree rather than this document.
			view.replaceWith( details );
		}

		const nodes = [ ...document.querySelectorAll< HTMLElement >( '.node-video' ) ];
		if ( nodes.length === 0 ) return;
		let doc: unknown;
		try {
			doc = JSON.parse( document.getElementById( '__NEXT_DATA__' )?.textContent ?? '' )
				?.props?.pageProps?.page?.publishedSnapshot?.content?.default;
		} catch {
			return;
		}
		type VideoAttrs = { embed?: { url?: unknown; aspectRatio?: unknown }; meta?: { title?: unknown } };
		const videos: VideoAttrs[] = [];
		const walk = ( node: unknown ): void => {
			if ( ! node || typeof node !== 'object' ) return;
			const { type, attrs, content } = node as { type?: unknown; attrs?: VideoAttrs; content?: unknown };
			if ( type === 'video' ) videos.push( attrs ?? {} );
			if ( Array.isArray( content ) ) content.forEach( walk );
		};
		walk( doc );
		if ( videos.length !== nodes.length ) return;

		nodes.forEach( ( node, index ) => {
			const { embed, meta } = videos[ index ]!;
			let src: URL;
			try {
				src = new URL( String( embed?.url ?? '' ) );
			} catch {
				return;
			}
			if ( src.protocol !== 'https:' ) return;
			const ratio = typeof embed?.aspectRatio === 'number' && embed.aspectRatio > 0 ? embed.aspectRatio : 16 / 9;
			const frame = document.createElement( 'iframe' );
			frame.src = src.href;
			frame.title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : 'Video';
			frame.allow = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
			frame.allowFullscreen = true;
			frame.style.cssText = `display:block;width:100%;height:auto;aspect-ratio:${ ratio };border:0`;
			// Detach Gamma's node view rather than emptying it: a later render of the
			// player then updates the detached subtree, not this document.
			const view = node.querySelector( ':scope > [data-node-view-wrapper]' );
			if ( view ) view.replaceWith( frame );
			else node.replaceChildren( frame );
		} );
	} );
}
