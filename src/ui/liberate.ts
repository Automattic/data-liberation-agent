// src/ui/liberate.ts
//
// URL -> complete, portable HTML site. This is the product's primary path:
// liberate every retained route into a self-contained site directory and hand
// back a runnable local copy. No WordPress, Studio, or destination-specific
// step participates here — the HTML on disk is the contract.
//
import { join } from 'node:path';
import { captureWebsite } from '../lib/capture.js';
import type { CaptureOptions, UnresolvedAnchor } from '../lib/capture.js';
import { isUsableCapture, type MissingRoute } from '../lib/capture-usability.js';
import { siteOutputDir } from '../lib/paths.js';
import { startStaticServer } from '../lib/replicate/local-site/static-server.js';
import type { StaticServer } from '../lib/replicate/local-site/static-server.js';
import { authorPortableMotion, type PortableMotionRecipe } from '../lib/portable-motion.js';

export interface LiberateOptions {
	acquisition?: CaptureOptions['acquisition'];
	http?: CaptureOptions['http'];
	/** Route budget shared by browser and HTTP capture. Browser default: 50; 'all' captures every route. */
	routeLimit?: CaptureOptions['routeLimit'];
	/** How the route budget picks routes; see `CaptureOptions.routeSelection`. Default: 'discovery-order'. */
	routeSelection?: CaptureOptions['routeSelection'];
	url: string;
	/** Base directory; the site lands in a per-source subdirectory. */
	outputBase: string;
	resume?: boolean;
	/** Capture PNG screenshots alongside the HTML. Default: false. */
	screenshots?: boolean;
	/** Serve the liberated site over HTTP. Default: true. */
	serve?: boolean;
	/** Learn responsive sizing across widths rather than freezing one. Default: true. */
	learnFluid?: boolean;
	/**
	 * Freeze baseline reference evidence for at most this many routes
	 * (homepage plus an even sample of the initial routes). Unsampled routes
	 * skip reference navigation; frozen comparison reports them as uncompared
	 * scope. Default: the homepage only; 'all' freezes every route.
	 */
	referenceSample?: number | 'all';
	/** Capture time budget in ms until export must begin; see `CaptureOptions.timeBudgetMs`. Default: none. */
	timeBudgetMs?: number;
	/** Per-file export cap in bytes; see `CaptureOptions.maxFileBytes`. Default: 50 MiB. */
	maxFileBytes?: number;
	/** Total export budget in bytes; see `CaptureOptions.maxTotalBytes`. Default: 250 MiB. */
	maxTotalBytes?: number;
	/** Total export budget in files; see `CaptureOptions.maxFiles`. Default: 5000. */
	maxFiles?: number;
	/** Capture the phone profile per route (`dual`), skip it when the phone view is CSS reflow (`reflow-only`), or decide on the entrypoint (`auto`, default); see `CaptureOptions.deviceMode`. */
	deviceMode?: CaptureOptions['deviceMode'];
	/** Optional authored runtime; installed only after live source/portable behavior comparison passes. */
	portableMotion?: PortableMotionRecipe;
	log?: ( message: string ) => void;
}

export interface LiberateResult {
	outputDir: string;
	websiteDir: string;
	routesDiscovered: number;
	routesCaptured: number;
	/** Routes already on disk and reused instead of recaptured. */
	routesSkipped: number;
	routesFailed: number;
	/** Discovered routes the route budget left out on purpose; never counted as failed. */
	routesOmitted: number;
	complete: boolean;
	entrypointCaptured: boolean;
	missingRoutes: MissingRoute[];
	/** Recommended policy (README "Usable partial captures"): entrypoint captured and few failed routes. */
	usable: boolean;
	unresolvedAnchors: UnresolvedAnchor[];
	/** Running local server, or null when serving is disabled. */
	server: StaticServer | null;
}

export async function liberateSite( options: LiberateOptions ): Promise< LiberateResult > {
	const log = options.log ?? ( () => {} );
	const outputDir = siteOutputDir( options.outputBase, options.url );

	const capture = await captureWebsite( {
		acquisition: options.acquisition, http: options.http, routeLimit: options.routeLimit,
		...( options.routeSelection !== undefined ? { routeSelection: options.routeSelection } : {} ),
		url: options.url,
		outputDir,
		resume: options.resume,
		captureImages: options.screenshots,
		learnFluid: options.learnFluid !== false,
		referenceSample: options.referenceSample,
		timeBudgetMs: options.timeBudgetMs,
		maxFileBytes: options.maxFileBytes,
		maxTotalBytes: options.maxTotalBytes,
		maxFiles: options.maxFiles,
		...( options.deviceMode !== undefined ? { deviceMode: options.deviceMode } : {} ),
		onProgress: ( progress ) => {
			if ( progress.phase === 'capturing' && progress.total ) {
				log(
					`[liberate] ${ progress.current ?? 0 }/${ progress.total } ${ progress.unit ? `${ progress.unit } ` : '' }${ progress.url ?? '' }`.trim()
				);
				return;
			}
			log( `[liberate] ${ progress.phase }` );
		},
	} );

	const websiteDir = join( outputDir, 'website' );
	if ( options.portableMotion && capture.complete ) {
		log( '[liberate] verifying authored portable motion against the live source' );
		await authorPortableMotion( outputDir, options.portableMotion );
	}
	return {
		outputDir,
		websiteDir,
		routesDiscovered: capture.summary.routesDiscovered,
		routesCaptured: capture.summary.routesCaptured,
		routesSkipped: capture.summary.routesSkipped,
		routesFailed: capture.summary.routesFailed,
		routesOmitted: capture.summary.routesOmitted,
		complete: capture.complete,
		entrypointCaptured: capture.entrypointCaptured,
		missingRoutes: capture.missingRoutes,
		usable: isUsableCapture( capture ),
		unresolvedAnchors: capture.unresolvedAnchors,
		server: options.serve === false ? null : await startStaticServer( websiteDir ),
	};
}
