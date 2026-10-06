import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';

const VIEWPORTS = [ 'desktop', 'mobile' ] as const;
export type ViewportId = ( typeof VIEWPORTS )[ number ];

export interface ArtifactPlan {
	needsLoad: boolean;
	captureFullpage: boolean;
	captureScrolled: boolean;
	captureHtml: boolean;
	/** Capture the JS-built mobile DOM (full document) on the MOBILE pass, for the
	 *  alt path's iframe mobile-DOM carry (classic/adaptive Wix). Mobile-only — the
	 *  counterpart to `captureHtml`'s desktop-only gate. */
	captureMobileHtml: boolean;
	/** Capture per-page section specs (extractFull) on the desktop pass, so the
	 *  reconstruction phase can read them instead of re-running Playwright. */
	captureSections: boolean;
	/** Capture mobile computed section evidence for responsive reconstruction. */
	captureMobileSections: boolean;
	/** Capture bounded geometry proof observations for generic downstream consumers. */
	captureGeometry: boolean;
	paths: {
		fullpage: string;
		scrolled: string;
		html: string;
		htmlMobile: string;
		sections: string;
		sectionsMobile: string;
		geometry: string;
	};
}

export interface CapturePlan {
	desktop: ArtifactPlan;
	mobile: ArtifactPlan;
}

/** Reject outputDir paths containing `..` traversal. (No longer cwd-pinned:
 *  the default base is now user-owned under ~/Studio, and explicit --output is
 *  trusted user intent. Per-file joins stay contained at their join sites —
 *  resolveMediaPath checks containment, slugs are separator-free.) */
export function validateOutputDir( outputDir: string ): void {
	const norm = normalize( outputDir );
	if ( norm.split( '/' ).includes( '..' ) || norm.split( '\\' ).includes( '..' ) ) {
		throw new Error( `outputDir contains '..' traversal: ${ outputDir }` );
	}
}

/** Claim a slug, appending -2, -3, ... on collision. Mutates `seen`. */
export function claimSlug( base: string, seen: Map< string, number > ): string {
	const existing = seen.get( base );
	if ( existing === undefined ) {
		seen.set( base, 1 );
		return base;
	}
	const next = existing + 1;
	seen.set( base, next );
	return `${ base }-${ next }`;
}

/**
 * Given an outputDir + slug, decide which artifacts we still need to capture
 * for each viewport and whether we need to load the page at all.
 *
 *   viewport.needsLoad = true if ANY of its artifacts are missing (or force)
 *   → we load the page once and capture whatever's missing
 */
export function planArtifacts( args: {
	slug: string;
	outputDir: string;
	force: boolean;
	captureImages?: boolean;
} ): CapturePlan {
	const plan = ( viewport: ViewportId ): ArtifactPlan => {
		const fullpage = join( args.outputDir, 'screenshots', viewport, `${ args.slug }.png` );
		const scrolled = join( args.outputDir, 'screenshots', viewport, `${ args.slug }.scrolled.png` );
		const html = join( args.outputDir, 'html', `${ args.slug }.html` );
		const htmlMobile = join( args.outputDir, 'html-mobile', `${ args.slug }.html` );
		const sections = join( args.outputDir, 'sections', `${ args.slug }.json` );
		const sectionsMobile = join( args.outputDir, 'sections-mobile', `${ args.slug }.json` );
		const geometry = join( args.outputDir, 'layout-geometry', `${ args.slug }.${ viewport }.json` );
		const captureImages = args.captureImages === true;
		const captureFullpage = captureImages && ( args.force || ! existsSync( fullpage ) );
		const captureScrolled = captureImages && ( args.force || ! existsSync( scrolled ) );
		// HTML + section specs are captured on the desktop pass only (specs are
		// viewport-relative; desktop 1440×900 matches the live-extract basis).
		const captureHtml = viewport === 'desktop' && ( args.force || ! existsSync( html ) );
		// The mobile DOM (full document) is captured on the MOBILE pass — Wix serves a
		// different layout to mobile UAs, so it must come from the emulated mobile pass.
		const captureMobileHtml = viewport === 'mobile' && ( args.force || ! existsSync( htmlMobile ) );
		const captureSections = viewport === 'desktop' && ( args.force || ! existsSync( sections ) );
		const captureMobileSections =
			viewport === 'mobile' && ( args.force || ! existsSync( sectionsMobile ) );
		const captureGeometry = args.force || ! existsSync( geometry );
		const needsLoad =
			captureFullpage ||
			captureScrolled ||
			captureHtml ||
			captureMobileHtml ||
			captureSections ||
			captureMobileSections ||
			captureGeometry;
		return {
			needsLoad,
			captureFullpage,
			captureScrolled,
			captureHtml,
			captureMobileHtml,
			captureSections,
			captureMobileSections,
			captureGeometry,
			paths: { fullpage, scrolled, html, htmlMobile, sections, sectionsMobile, geometry },
		};
	};
	return { desktop: plan( 'desktop' ), mobile: plan( 'mobile' ) };
}

/** Additional identities use the same capture transaction, with isolated paths.
 * Legacy section/design sidecars remain desktop/mobile; they are not overwritten.
 */
export function planDocumentArtifacts( args: { slug: string; outputDir: string; id: string; force: boolean; captureImages?: boolean } ): ArtifactPlan {
	if ( ! /^[a-z][a-z0-9-]*$/.test( args.id ) || [ 'desktop', 'mobile' ].includes( args.id ) ) throw new Error( 'Invalid additional document identity' );
	const base = planArtifacts( args ).desktop;
	const html = join( args.outputDir, `html-${ args.id }`, `${ args.slug }.html` );
	const fullpage = join( args.outputDir, 'screenshots', args.id, `${ args.slug }.png` );
	const scrolled = join( args.outputDir, 'screenshots', args.id, `${ args.slug }.scrolled.png` );
	const geometry = join( args.outputDir, 'layout-geometry', `${ args.slug }.${ args.id }.json` );
	const captureHtml = args.force || ! existsSync( html );
	const captureGeometry = args.force || ! existsSync( geometry );
	const captureFullpage = args.captureImages === true && ( args.force || ! existsSync( fullpage ) );
	const captureScrolled = args.captureImages === true && ( args.force || ! existsSync( scrolled ) );
	return { ...base, needsLoad: captureHtml || captureGeometry || captureFullpage || captureScrolled,
		captureHtml, captureGeometry, captureFullpage, captureScrolled,
		captureMobileHtml: false, captureSections: false, captureMobileSections: false,
		paths: { ...base.paths, html, fullpage, scrolled, geometry },
	};
}
