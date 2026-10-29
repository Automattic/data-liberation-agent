import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectAssets } from './image-assets.js';
import { downloadMedia } from './media-fetch/media.js';
import { MediaStubStore } from './resume-state/index.js';
import type { SourceRequestGovernors } from './source-request-governor.js';

/**
 * Capture-wide asset byte acquisition (#1049).
 *
 * Each captured route enqueues its asset originals as soon as its documents
 * are saved, so bytes arrive while later routes are still in the browser
 * instead of after the time budget is spent. Fetches go through the source
 * origin's governor and land in the MediaStubStore under media/, where
 * `captureAssets()` reuses URL-owned local bytes. Verification, decoding and
 * portability stay with `captureAssets()`; this queue only fetches.
 */
export class AssetAcquisitionQueue {
	private readonly mediaDir: string;
	private readonly names = new Map< string, number >();
	private readonly stubs: MediaStubStore;
	private readonly seen = new Set< string >();
	private readonly pending = new Set< Promise< void > >();
	private fetched = 0;
	private failed = 0;
	private bytes = 0;

	constructor(
		private readonly outputDir: string,
		private readonly governors: SourceRequestGovernors,
		private readonly deadline?: number,
		private readonly resolve?: Parameters< typeof collectAssets >[ 1 ]
	) {
		this.mediaDir = join( outputDir, 'media' );
		if ( existsSync( this.mediaDir ) ) for ( const name of readdirSync( this.mediaDir ) ) this.names.set( name, 1 );
		this.stubs = MediaStubStore.load( outputDir );
	}

	/** Enqueue the asset originals referenced by one captured route's documents (paths relative to outputDir). */
	enqueueRoute( url: string, documentPaths: string[], stored: ( resourceUrl: string ) => boolean = () => false ): void {
		const documents = documentPaths
			.map( path => join( this.outputDir, path ) )
			.filter( path => existsSync( path ) )
			.map( path => ( { url, html: readFileSync( path, 'utf8' ) } ) );
		for ( const record of collectAssets( documents, this.resolve ) ) {
			const source = record.resolved_original;
			if ( this.seen.has( source ) ) continue;
			this.seen.add( source );
			if ( stored( source ) || this.stubs.get( source )?.status === 'success' ) continue;
			const task = this.fetch( source ).finally( () => this.pending.delete( task ) );
			this.pending.add( task );
		}
	}

	private async fetch( source: string ): Promise< void > {
		let governor;
		try {
			governor = this.governors.forOrigin( source );
		} catch {
			return;
		}
		const { response } = await governor.run( async () => {
			// Fetches queued behind the governor do not start after the deadline.
			if ( this.deadline !== undefined && Date.now() >= this.deadline ) return { status: 0, headers: new Headers(), result: undefined };
			const result = await downloadMedia( source, this.mediaDir, this.names, undefined, { preserveOriginal: true } );
			const status = Number( /^HTTP (\d{3})$/.exec( result.error ?? '' )?.[ 1 ] ?? 200 );
			return { status, headers: new Headers(), result };
		} );
		const result = response.result;
		if ( ! result ) return;
		if ( ! result.localPath ) {
			this.failed++;
			return;
		}
		this.fetched++;
		this.bytes += result.bytes;
		this.stubs.markSuccess( source, relative( this.outputDir, result.localPath ) );
	}

	/** Wait for fetches already queued; persist the store `captureAssets()` reads. */
	async drain(): Promise< void > {
		const startedAt = Date.now();
		while ( this.pending.size ) await Promise.all( [ ...this.pending ] );
		this.stubs.flush();
		process.stderr.write(
			`[timing] asset-queue ${ JSON.stringify( { enqueued: this.seen.size, fetched: this.fetched, failed: this.failed, bytes: this.bytes, drainMs: Date.now() - startedAt } ) }\n`
		);
	}
}
