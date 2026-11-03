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
