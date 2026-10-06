/** Source acquisition is independent of rendering, localization and destinations. */
export interface HttpDocumentContext {
	url: string;
	finalUrl: string;
	variant: string;
}

export interface RuntimeRegionRequirement {
	selector: string;
	reason: string;
}

export interface PreparedHttpDocument {
	html: string;
	/** Platform evidence that describes the acquired route, not rendered parity. */
	metadata?: Record<string, string>;
	/** Source-declared surfaces that still need bounded browser observation. */
	browserRegions?: ReadonlyArray<RuntimeRegionRequirement>;
}

export interface HttpAcquisitionProfile {
	id: string;
	/** Explicit portable document roles; required for orchestrating multiple variants. */
	exportVariants?: { desktop: string; mobile?: string };
	/** Platform-owned readiness for declared runtime regions on a replayed source page. */
	prepareRuntimeRegions?: ( page: import('playwright').Page, context: HttpDocumentContext ) => Promise<void>;
	variants: ReadonlyArray<{ id: string; headers?: Record<string, string> }>;
	/** Return undefined when the source needs the existing browser capture path. */
	prepare( html: string, context: HttpDocumentContext ): PreparedHttpDocument | undefined | Promise<PreparedHttpDocument | undefined>;
}
