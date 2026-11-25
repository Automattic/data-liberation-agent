import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { findAdapter } from '../adapters/index.js';
import { tryCollectCapturedRoute } from './capture-export-collection.js';
import { browserRouteCollectionContext, type RouteCollectionOptions } from './capture-export.js';
import { withParsedDocuments } from './parsed-documents.js';

/** Collects the routes it is sent; see capture-export-parallel.ts. */
const { options, platform, dir } = workerData as { options: Omit<RouteCollectionOptions, 'resolveDocumentSelection'>; platform: string; dir: string };
const { entries, context } = browserRouteCollectionContext( { ...options, resolveDocumentSelection: findAdapter( platform )?.liberation?.documentSelection } );
parentPort!.on( 'message', ( { url, ordinal }: { url: string; ordinal: number } ) => {
	const route = withParsedDocuments( () => tryCollectCapturedRoute( url, entries[ url ], context, html => {
		const path = join( dir, `${ ordinal }.html` );
		writeFileSync( path, html );
		return path;
	} ) );
	parentPort!.postMessage( { url, route } );
} );
