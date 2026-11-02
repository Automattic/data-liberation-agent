import { describe, expect, it } from 'vitest';
import { decodeHtml } from './decode-html.js';
import { SHIFT_JIS_TITLE } from './shift-jis-fixture.js';
const page = ( head: string ) => Buffer.concat( [ Buffer.from( `<html><head>${ head }<title>` ), SHIFT_JIS_TITLE, Buffer.from( '</title></head></html>' ) ] );

describe( 'decodeHtml', () => {
	it.each( [
		[ 'transport charset', page( '' ), 'text/html; charset=Shift_JIS' ],
		[ 'meta charset', page( '<meta charset="shift_jis">' ), 'text/html' ],
		[ 'meta http-equiv', page( '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">' ), 'text/html' ],
		[ 'unsupported transport label falls through to meta', page( '<meta charset="Shift_JIS">' ), 'text/html; charset=x-no-such-encoding' ],
	] )( 'decodes Shift_JIS declared by %s', ( _case, bytes, contentType ) => {
		expect( decodeHtml( bytes, contentType ) ).toContain( '<title>キューティー★コンプレックス</title>' );
	} );

	it( 'lets a byte order mark override declarations', () => {
		const bytes = Buffer.concat( [ Buffer.from( [ 0xef, 0xbb, 0xbf ] ), Buffer.from( '<meta charset="shift_jis"><title>é</title>' ) ] );
		expect( decodeHtml( bytes, 'text/html; charset=Shift_JIS' ) ).toContain( '<title>é</title>' );
	} );
} );
