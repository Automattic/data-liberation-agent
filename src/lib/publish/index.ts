// src/lib/publish/index.ts
//
// Target registry. Adding a destination means adding a PublishTarget here; the
// liberation core never learns about any of them.
//
import { spacefastTarget } from './spacefast.js';
import type { PublishTarget } from './types.js';

export const publishTargets: PublishTarget[] = [ spacefastTarget ];

export function findPublishTarget( name: string ): PublishTarget | null {
	const wanted = name.trim().toLowerCase();
	return publishTargets.find( ( target ) => target.name === wanted ) ?? null;
}

export function publishTargetNames(): string[] {
	return publishTargets.map( ( target ) => target.name );
}

export { PublishError } from './types.js';
export type { PublishOptions, PublishResult, PublishTarget } from './types.js';
