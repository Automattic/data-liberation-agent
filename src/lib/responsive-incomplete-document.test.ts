import { describe, expect, it } from 'vitest';
import { assembleResponsiveCapture, incompleteDeviceDocument } from './responsive-assembly.js';

// Reduced real capture shapes (#1411): nested shared identity wrappers survive
// bootstrap, but the section content has not yet arrived. The first shell has
// no sections and residual chrome text; the second has one of nine sections.
const document = ( sections: number, text: string ) => `<!doctype html><html><head><style>section{display:block}</style></head><body><div id="site"><header id="header">Navigation</header><main id="pages"><div id="page"><div id="content">${Array.from( { length: sections }, ( _, i ) => `<section id="section-${i}"><p>${text}</p></section>` ).join( '' )}</div></div></main><footer id="footer">Contact</footer></div><script>${'bootstrap '.repeat( 1000 )}</script></body></html>`;

describe( 'incomplete dual-device documents', () => {
	it.each( [
		{ device: 'mobile', sections: 8, missingSections: 0 },
		{ device: 'desktop', sections: 9, missingSections: 1 },
	] as const )( 'keeps complete content at both widths when $device is a shell', ( { device, sections, missingSections } ) => {
		const complete = document( sections, 'Real captured page content. '.repeat( 20 ) );
		const shell = document( missingSections, 'Loading' );
		const desktop = device === 'desktop' ? shell : complete;
		const mobile = device === 'mobile' ? shell : complete;
		const assemble = ( d: string, m: string ) => assembleResponsiveCapture( {
			rawDesktopHtml: d, rawMobileHtml: m,
			portableDesktopHtml: d, portableMobileHtml: m,
		} );
		const fallback = assemble( desktop, mobile );
		expect( fallback.html ).toBe( complete );
		expect( fallback.hasMobileDocument ).toBe( false );
		const finding = incompleteDeviceDocument( desktop, mobile );
		expect( finding ).toMatchObject( { device } );
		expect( finding?.[ device ].sections ).toBe( missingSections );
		expect( incompleteDeviceDocument( complete, complete ) ).toBeUndefined();
		expect( fallback.html ).not.toMatch( /data-blocks-engine-capture-(desktop|mobile)-(only|document)/ );
		// A successful fresh capture is no longer rejected.
		expect( assemble( complete, complete ).html ).toContain( 'Real captured page content.' );
	} );

	it.each( [ 'desktop', 'mobile' ] as const )( 'detects a $device shell whose shared chrome masks an empty main landmark', device => {
		// Reduced Wix shape: header and footer sections carry the chrome text;
		// the page widget inside main serialized in its empty, unhydrated state.
		const chrome = ( main: string ) => `<!doctype html><html><body><div id="site"><header><section>${ 'Shop Events Portfolio Contact '.repeat( 4 ) }</section></header><main id="pages"><section>${ main }</section></main><footer><section>${ 'Imprint Privacy Newsletter '.repeat( 4 ) }</section></footer></div></body></html>`;
		const complete = chrome( `<h1>Pride Collection</h1><p>${ 'Collection description. '.repeat( 10 ) }</p>` );
		const shell = chrome( '<div class="project-widget is-empty"></div>' );
		const finding = incompleteDeviceDocument( device === 'desktop' ? shell : complete, device === 'mobile' ? shell : complete );
		expect( finding ).toMatchObject( { device } );
		expect( finding?.[ device ].main ).toEqual( { textLength: 0, media: 0 } );
		expect( incompleteDeviceDocument( complete, complete ) ).toBeUndefined();
		// Device reflow that keeps any main content is not a shell.
		const sparse = chrome( '<img src="/hero.jpg" alt="">' );
		expect( incompleteDeviceDocument( sparse, complete ) ).toBeUndefined();
	} );
} );
