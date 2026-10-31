import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectAssets } from './image-assets.js';
import { downloadMedia, existingMediaNames } from './media-fetch/media.js';
import { MediaStubStore } from './resume-state/index.js';
import { SOURCE_REQUEST_GOVERNOR_DEFAULTS, type SourceRequestGovernors } from './source-request-governor.js';

/**
 * Capture-wide asset byte acquisition (#1049).
 *
 * Each captured route enqueues its asset originals as soon as its documents
 * are saved, so bytes arrive while later routes are still in the browser
 * instead of after the time budget is spent. Fetches go through the source
 * origin's governor and land in the MediaStubStore under media/, where
 * `captureAssets()` reuses URL-owned local bytes. At most `concurrency`
 * fetches run at once, below the governor's limit, so route navigation keeps
 * priority on the source. Verification, decoding and
 * portability stay with `captureAssets()`; this queue only fetches.
 */
export class AssetAcquisitionQueue {
	private readonly mediaDir: string;
	private readonly names: Map< string, number >;
	private readonly stubs: MediaStubStore;
	private readonly seen = new Set< string >();
	private readonly waiting: string[] = [];
	private readonly pending = new Set< Promise< void > >();
	private fetched = 0;
	private failed = 0;
	private bytes = 0;
	private routes = 0;
	private queued = 0;
	private attempts = 0;
	private attemptMs = 0;

	constructor(
		private readonly outputDir: string,
		private readonly governors: SourceRequestGovernors,
		private readonly deadline?: number,
		private readonly resolve?: Parameters< typeof collectAssets >[ 1 ],
		private readonly concurrency = 2,
		/** Epoch ms after which no route starts: downloads then take the origin's full concurrency. */
		private readonly admissionClosesAt?: number
	) {
		this.mediaDir = join( outputDir, 'media' );
		this.names = existingMediaNames( this.mediaDir );
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
			this.waiting.push( source );
			this.queued++;
		}
		this.routes++;
		this.pump();
	}

	private pump(): void {
		// Routes keep priority on the source only while new ones can start.
		const limit = this.admissionClosesAt !== undefined && Date.now() >= this.admissionClosesAt
			? Math.max( this.concurrency, SOURCE_REQUEST_GOVERNOR_DEFAULTS.concurrency )
			: this.concurrency;
		while ( this.pending.size < limit && this.waiting.length ) {
			const task = this.fetch( this.waiting.shift()! ).finally( () => {
				this.pending.delete( task );
				this.pump();
			} );
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
			const startedAt = Date.now();
			const result = await downloadMedia( source, this.mediaDir, this.names, undefined, { preserveOriginal: true } );
			this.attempts++;
			this.attemptMs += Date.now() - startedAt;
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

	/**
	 * Fetch time still owed, at the observed cost per fetch and this queue's
	 * concurrency: `queuedMs` for what is waiting or in flight now, `perRouteMs`
	 * for what one more captured route adds on average. Zero until a fetch has
	 * finished, so admission is not held back on no evidence.
	 */
	backlog(): { queuedMs: number; perRouteMs: number } {
		if ( ! this.attempts ) return { queuedMs: 0, perRouteMs: 0 };
		const slotMs = this.attemptMs / this.attempts / this.concurrency;
		return { queuedMs: ( this.waiting.length + this.pending.size ) * slotMs, perRouteMs: this.routes ? ( this.queued / this.routes ) * slotMs : 0 };
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
