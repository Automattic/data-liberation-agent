const CHARSET = /charset\s*=\s*["']?([^;\s"'/>]+)/i;
const META_CHARSET = /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s"'/>;]+)/i;
const META_HTTP_EQUIV = /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*\bcontent\s*=\s*["'][^"']*?charset\s*=\s*([^;\s"']+)/i;

function supported( label: string | undefined ): label is string {
	if ( ! label ) return false;
	try {
		new TextDecoder( label );
		return true;
	} catch {
		return false;
	}
}

function bomEncoding( bytes: Uint8Array ): string | undefined {
	if ( bytes[ 0 ] === 0xef && bytes[ 1 ] === 0xbb && bytes[ 2 ] === 0xbf ) return 'utf-8';
	if ( bytes[ 0 ] === 0xfe && bytes[ 1 ] === 0xff ) return 'utf-16be';
	if ( bytes[ 0 ] === 0xff && bytes[ 1 ] === 0xfe ) return 'utf-16le';
	return undefined;
}

/**
 * Decodes an HTML response body in the HTML encoding sniffing order: byte
 * order mark, transport `charset`, a `<meta>` declaration in the first 1024
 * bytes, then UTF-8. Labels the runtime cannot decode are skipped. Legacy
 * sites (Shift_JIS, EUC-JP, windows-1252) usually declare their encoding only
 * in `<meta>`.
 */
export function decodeHtml( bytes: Uint8Array, contentType = '', { fatal = true }: { fatal?: boolean } = {} ): string {
	const prefix = new TextDecoder( 'latin1' ).decode( bytes.subarray( 0, 1024 ) );
	const label = bomEncoding( bytes )
		?? [ CHARSET.exec( contentType )?.[ 1 ], META_CHARSET.exec( prefix )?.[ 1 ], META_HTTP_EQUIV.exec( prefix )?.[ 1 ] ].find( supported )
		?? 'utf-8';
	return new TextDecoder( label, { fatal } ).decode( bytes );
}
