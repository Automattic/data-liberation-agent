import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { findAdapter } from '../adapters/index.js';
import type { CollectedRoute, FailedRouteCollection, ScreenshotManifest } from './capture-export-collection.js';
import type { ExportCaptureOptions } from './capture-export.js';

/** A route collection holds a few parsed copies of a large builder page; workers use at most a quarter of memory. */
const WORKER_MEMORY_BYTES = 1.5 * 1024 ** 3;
const MAX_WORKERS = 8;
/** Below this, starting workers (each loads the export modules) costs more than collecting inline. */
export const MIN_PARALLEL_ROUTES = 8;

export interface PrecollectedRoutes {
	routes: Map< string, CollectedRoute | FailedRouteCollection >;
	/** Remove the collected pages once the export has staged its own copies. */
	release(): void;
}

/**
 * Find the route worker. `moduleUrl` is this module's `import.meta.url` and
 * `runningFile` is the file Node runs. They differ only in the capture-engine
 * bundle: its build points `import.meta.url` at this module's source file under
 * src/, but tsc writes the built worker under dist/.
 */
export function routeWorkerScript( moduleUrl: string, runningFile: string ): { url: URL; tsx: boolean } | undefined {
	// Running from source (tests, `npm run liberate`), the worker is loaded through tsx.
	if ( runningFile.endsWith( '.ts' ) ) return { url: new URL( './capture-export-route-worker.ts', moduleUrl ), tsx: true };
	const url = new URL( moduleUrl.endsWith( '.ts' ) ? '../../dist/lib/capture-export-route-worker.js' : './capture-export-route-worker.js', moduleUrl );
	// Without a built worker (a bundle copied on its own), the export collects inline.
	return existsSync( fileURLToPath( url ) ) ? { url, tsx: false } : undefined;
}

/**
 * Collect a browser capture's routes in worker threads before export. Each
 * route is independent (see `collectCapturedRoute`), and collection is most of
 * an export's CPU, so this is where export uses the machine's cores. The
 * export itself stays synchronous and consumes the results; a route a worker
 * did not return is collected inline by the export as before.
 */
export async function precollectCapturedRoutes( options: ExportCaptureOptions ): Promise< PrecollectedRoutes | undefined > {
	// HTTP input and runtime attachments carry state the worker does not rebuild.
	if ( options.input || options.embeddedDocuments ) return undefined;
	const selection = findAdapter( options.platform )?.liberation?.documentSelection;
	if ( options.resolveDocumentSelection && options.resolveDocumentSelection !== selection ) return undefined;
	const manifestPath = join( options.outputDir, 'screenshots', 'manifest.json' );
	if ( ! existsSync( manifestPath ) ) return undefined;
	const urls = Object.entries( ( JSON.parse( readFileSync( manifestPath, 'utf8' ) ) as ScreenshotManifest ).entries ).filter( ( [ , entry ] ) => entry.html ).map( ( [ url ] ) => url );
	if ( urls.length < MIN_PARALLEL_ROUTES ) return undefined;
	const workers = Math.min( urls.length, MAX_WORKERS, availableParallelism() - 1, Math.floor( totalmem() / 4 / WORKER_MEMORY_BYTES ) );
	if ( workers < 2 ) return undefined;
	const script = routeWorkerScript( import.meta.url, import.meta.filename );
	if ( ! script ) return undefined;
	const dir = mkdtempSync( join( tmpdir(), 'export-routes-' ) );
	const release = () => rmSync( dir, { recursive: true, force: true } );
	const routes = new Map< string, CollectedRoute | FailedRouteCollection >();
	const startedAt = Date.now();
	const { structuredContent, routeScope, failures, deviceMode, limits, outputDir, sourceUrl } = options;
	const workerData = { options: { structuredContent, routeScope, failures, deviceMode, limits, outputDir, sourceUrl }, platform: options.platform, dir };
	try {
		structuredClone( workerData );
	} catch {
		// Options carrying functions cannot reach a worker; the export collects inline.
		release();
		return undefined;
	}
	let next = 0;
	const run = () => new Promise< void >( done => {
		let worker: Worker;
		try {
			worker = new Worker( script.url, { workerData, ...( script.tsx ? { execArgv: [ '--import', 'tsx' ] } : {} ) } );
		} catch ( error ) {
			process.stderr.write( `[export] route worker failed to start: ${ ( error as Error ).message }\n` );
			done();
			return;
		}
		const send = () => {
			if ( next >= urls.length ) { void worker.terminate(); return; }
			const ordinal = next++;
			worker.postMessage( { url: urls[ ordinal ], ordinal } );
		};
		worker.on( 'message', ( { url, route }: { url: string; route: CollectedRoute | FailedRouteCollection } ) => { routes.set( url, route ); send(); } );
		// A worker that dies leaves its routes to the export's inline collection.
		worker.on( 'error', ( error: Error ) => process.stderr.write( `[export] route worker stopped: ${ error.message }\n` ) );
		worker.on( 'exit', () => done() );
		send();
	} );
	try {
		await Promise.all( Array.from( { length: workers }, run ) );
	} catch ( error ) {
		release();
		throw error; // failure-class: programmer
	}
	process.stderr.write( `[timing] route-collection ${ Date.now() - startedAt }ms (${ routes.size } of ${ urls.length } routes, ${ workers } workers)\n` );
	return { routes, release };
}
