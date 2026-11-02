import type { Page } from 'playwright';

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
