import type { Page } from 'playwright';
import { orElse } from '../failure-class.js';

/** Only tokens changed by opening; unrelated root classes remain consumer-owned. */
export interface CapturedRootClassState {
	root: 'html' | 'body';
	removed: string[];
	added: string[];
}

export async function rootClasses( page: Page ): Promise<Record<'html' | 'body', string[]>> {
	return page.evaluate( () => ( {
		html: [ ...document.documentElement.classList ],
		body: [ ...document.body.classList ],
	} ) );
}

export function rootClassDelta( closed: Awaited<ReturnType<typeof rootClasses>>, opened: Awaited<ReturnType<typeof rootClasses>> ): CapturedRootClassState[] {
	return ( [ 'html', 'body' ] as const ).map( root => ( {
		root,
		removed: closed[root].filter( token => !opened[root].includes( token ) ),
		added: opened[root].filter( token => !closed[root].includes( token ) ),
	} ) ).filter( row => row.removed.length || row.added.length );
}

/**
 * Whether closing restored every root token opening changed. A runtime can
 * release its scroll lock a few frames after it hides the panel (after its
 * close transition), so restoration is awaited, bounded, rather than read
 * once: a single early read would drop the evidence for a state that does
 * restore.
 */
export async function rootClassesRestored( page: Page, state: readonly CapturedRootClassState[], timeoutMs: number ): Promise<boolean> {
	if ( ! state.length ) return true;
	const restored = ( current: Record<'html' | 'body', string[]> ) => state.every( row =>
		row.removed.every( token => current[row.root].includes( token ) ) && row.added.every( token => !current[row.root].includes( token ) ) );
	const deadline = Date.now() + timeoutMs;
	for ( ;; ) {
		const current = await rootClasses( page ).catch( orElse( undefined ) );
		if ( current && restored( current ) ) return true;
		if ( !current || Date.now() >= deadline ) return false;
		await page.waitForTimeout( 50 );
	}
}
