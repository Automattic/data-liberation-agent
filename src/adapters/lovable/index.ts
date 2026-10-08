import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';
import { detection } from './detection.js';

export const lovableAdapter: PlatformAdapter = {
	id: 'lovable',
	detection,
	discover: discoverDefault,
	liberation: {
		async prepare( page ) {
			// Builder inspection and the badge's close handler belong to the
			// removed provider chrome, not to the site's portable behavior.
			await page.evaluate( () => {
				for ( const script of Array.from( document.scripts ) ) {
					const type = script.type.trim().toLowerCase();
					if ( type && ! [ 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript' ].includes( type ) ) continue;
					if ( script.src ) {
						const url = new URL( script.src, location.href );
						if ( url.origin === location.origin && url.pathname === '/~flock.js' ) script.remove();
						continue;
					}
					const text = script.textContent ?? '';
					const calls = text.match( /\bdocument\.(?:querySelector(?:All)?|getElementById)\s*\(/g ) ?? [];
					const selectors = [ ...text.matchAll( /\bdocument\.(?:querySelector(?:All)?|getElementById)\s*\(\s*(['"])(#?lovable-badge[\w-]*)\1\s*\)/g ) ];
					const bindings = [ ...text.matchAll( /\b(?:const|let|var)\s+(\w+)\s*=\s*document\.(?:querySelector|getElementById)\s*\(/g ) ].map( match => match[ 1 ] );
					const allowedCalls = new Set( [ 'if', 'function', 'setTimeout', 'navigator.userAgent.includes', 'document.querySelector', 'document.getElementById', 'event.preventDefault', 'event.stopPropagation',
						...bindings.flatMap( name => [ `${ name }.addEventListener`, `${ name }.classList.add` ] ) ] );
					const knownCallsOnly = [ ...text.matchAll( /\b([\w$]+(?:\.[\w$]+)*)\s*\(/g ) ].every( match => allowedCalls.has( match[ 1 ]! ) );
					const knownWritesOnly = [ ...text.matchAll( /\b([\w$]+(?:\.[\w$]+)+)\s*=(?!=)/g ) ].every( match => bindings.some( name => match[ 1 ] === `${ name }.style.display` ) );
					// Mixed application scripts and dynamic lookups remain evidence.
					if ( calls.length && knownCallsOnly && knownWritesOnly && selectors.length === calls.length &&
						selectors.some( match => match[ 2 ] === '#lovable-badge-close' || match[ 2 ] === 'lovable-badge-close' ) &&
						! /\.(?:textContent|innerText|innerHTML)\s*=|\]\s*\(/g.test( text ) &&
						! /\bdocument\.(?!querySelector(?:All)?\s*\(|getElementById\s*\()/g.test( text ) ) script.remove();
				}
			} );
		},
		cleanupRules: [
			{ id: 'lovable-badge', category: 'source-attribution', selector: '#lovable-badge' },
			...providerCreditRules( 'lovable', [ 'lovable.dev', 'lovable.app' ], 'Lovable' ),
		],
	},
};
