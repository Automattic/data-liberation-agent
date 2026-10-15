import { exportWebsiteCapture } from './capture-export.js';

export interface HttpMaterializationOptions {
	routeScope?: import('../platform/types.js').SiteRouteScope;
	outputDir: string;
	sourceUrl: string;
	platform: string;
	desktopVariant: string;
	mobileVariant?: string;
	/** Include explicitly staged, hash-verified runtime child documents. */
	embeddedDocuments?: boolean;
	/** Routes skipped before capture because their rel=canonical is another inventory route (#835). */
	canonicalAliases?: ReadonlyArray< import('./route-aliases.js').CanonicalRouteAlias >;
	limits?: import('./capture-export.js').ExportLimits;
}

/** Produce a localized review candidate; HTTP coverage is not rendered acceptance. */
export function materializeHttpDocuments( options: HttpMaterializationOptions ): string {
	return exportWebsiteCapture( {
		...options,
		input: { kind: 'http', desktopVariant: options.desktopVariant, mobileVariant: options.mobileVariant },
		summary: {}, failures: [],
	} );
}
