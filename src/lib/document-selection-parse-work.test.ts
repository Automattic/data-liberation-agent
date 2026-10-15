import { describe, expect, it, vi } from 'vitest';
import { assembleDeviceDocuments, type DeviceDocumentSelection } from './document-selection.js';

// Markup handed to a loaded cheerio document and selectors fully parsed by
// the root-rule projection. Each projected stylesheet is already parsed as CSS;
// it must not be serialized back into markup and re-parsed as HTML, and a
// selector that cannot name a root or source body class must not be parsed.
const work = vi.hoisted( () => ( { markup: [] as string[], selectors: [] as string[] } ) );

vi.mock( 'cheerio', async original => {
	const cheerio = await original<typeof import( 'cheerio' )>();
	return {
		...cheerio,
		load: ( ...args: Parameters<typeof cheerio.load> ) => new Proxy( cheerio.load( ...args ), {
			apply( target, self, input ) {
				if ( typeof input[ 0 ] === 'string' ) work.markup.push( input[ 0 ] );
				return Reflect.apply( target, self, input );
			},
		} ),
	};
} );

vi.mock( 'postcss-selector-parser', async original => {
	const parser = ( await original<{ default: typeof import( 'postcss-selector-parser' ) }>() ).default;
	const counted = ( ( ...args: Parameters<typeof parser> ) => {
		const processor = parser( ...args );
		const astSync = processor.astSync.bind( processor );
		processor.astSync = ( selector, options ) => { work.selectors.push( String( selector ) ); return astSync( selector, options ); };
		return processor;
	} ) as typeof parser;
	return { default: Object.assign( counted, parser ) };
} );

const selection: DeviceDocumentSelection = {
	kind: 'device', id: 'neutral-request-identity/v1', documents: [ 'desktop', 'mobile' ], defaultDocument: 'desktop',
	rules: [ { userAgent: 'iPhone', document: 'mobile' } ],
	evidence: 'Fixture selects an authored document by request UA.',
};
const componentCss = Array.from( { length: 40 }, ( _, index ) => `.card-${ index } .title{margin:${ index }px}` ).join( '' );
const document = ( key: string ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style data-sheet="components">${ componentCss }</style><style data-sheet="roots">body{margin:0}.${ key }{padding:1px}.other{padding:2px}</style></head><body class="${ key }"><main>${ key }</main></body></html>`;

describe( 'device document assembly parse work', () => {
	it( 'projects stylesheets without re-parsing them as markup or parsing non-root selectors', () => {
		const assembly = assembleDeviceDocuments( { desktop: document( 'desktop' ), mobile: document( 'mobile' ) }, selection );

		expect( work.markup.filter( markup => markup.includes( '.card-0 .title' ) ) ).toEqual( [] );
		expect( work.selectors ).toEqual( [ '.desktop', '.mobile' ] );
		// The projection itself is unchanged: scoped components, root rules on the real roots.
		expect( assembly.html ).toContain( '<style data-sheet="components" data-blocks-engine-capture-device-style="mobile" data-blocks-engine-capture-source-media="all" media="not all">' );
		expect( assembly.html ).toContain( ':where([data-blocks-engine-capture-device-document="desktop"]) .card-39 .title{margin:39px}' );
		expect( assembly.html ).toContain( 'body{margin:0}:where(body).desktop{padding:1px}' );
		expect( assembly.html ).not.toContain( ':where(body).other' );
	} );
} );
