import { exportWebsiteCapture } from './capture-export.js';

export interface HttpMaterializationOptions {
	outputDir: string;
	sourceUrl: string;
	platform: string;
	desktopVariant: string;
	mobileVariant?: string;
	limits?: { portableMediaTotalBytes?: number };
}

/** Produce a localized review candidate; HTTP coverage is not rendered acceptance. */
export function materializeHttpDocuments( options: HttpMaterializationOptions ): string {
	return exportWebsiteCapture( {
		...options,
		input: { kind: 'http', desktopVariant: options.desktopVariant, mobileVariant: options.mobileVariant },
		summary: {}, failures: [],
	} );
}
