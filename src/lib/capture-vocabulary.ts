/**
 * Capture evidence vocabulary: the one table of names capture writes into the
 * exported site and its sidecars (#787 option A, part of #761).
 *
 * Blocks Engine owns this vocabulary as its producer-neutral capture-evidence
 * input contract (Automattic/blocks-engine `php-transformer/docs/contracts/
 * capture-evidence.md`, `Contract\CaptureEvidence`). Static Site Importer reads
 * names from the same namespace. Every attribute, class, id, id suffix and
 * probe token starts with `CAPTURE_EVIDENCE_PREFIX`; sidecar schemas live
 * under `CAPTURE_SCHEMA_NAMESPACE`. Classes deliberately share the attribute
 * prefix: Blocks Engine treats `blocks-engine-*` classes as its own generated
 * classes, so capture classes stay outside that namespace.
 *
 * Emitters spell the full names (many live inside runtime script and
 * stylesheet strings), or the `dataset.blocksEngineCapture<Name>` form of an
 * attribute. `capture-vocabulary.test.ts` keeps this table and the
 * source identical: every name the source spells is listed here, and every
 * name listed here is spelled by the source. See docs/contracts/capture-evidence.md.
 */
export const CAPTURE_EVIDENCE_PREFIX = 'data-blocks-engine-capture-';

/** Id suffix for a non-default document variant's copy of a shared source id: `<id>--data-blocks-engine-capture-<variant>`. */
export const CAPTURE_EVIDENCE_ID_SUFFIX = `--${ CAPTURE_EVIDENCE_PREFIX }`;

/** Sidecar schema namespace: `blocks-engine-capture/<name>/v<n>`. */
export const CAPTURE_SCHEMA_NAMESPACE = 'blocks-engine-capture/';

/**
 * Names after `CAPTURE_EVIDENCE_PREFIX`, grouped by family. Kind: `a` attribute,
 * `c` class, `i` element id, `t` probe or request token.
 */
export const CAPTURE_EVIDENCE_NAMES = {
	dialogs: {
		'dialog-trigger': 'a', 'dialog-panel': 'a', 'dialog-close': 'a', 'dialog-panel-state': 'a', 'dialog-ancestor-state': 'a',
		'dialog-ancestor-unverified': 'a', 'dialog-css': 'a', 'existing-panel': 'a', 'observed-placement': 'a', 'resting-panel': 'a',
		dialog: 'c', dropdown: 'c', 'initial-dialog': 'c',
	},
	disclosures: {
		disclosure: 'a', 'disclosure-base': 'a', 'disclosure-label': 'a', 'disclosure-runtime': 'a',
		'disclosure-open-class': 'a', 'disclosure-closed-class': 'a', 'disclosure-open-style': 'a', 'disclosure-closed-style': 'a',
		'disclosure-transition': 'a',
		'local-disclosure': 'a', 'local-disclosure-runtime': 'a', 'exclusive-disclosures': 'a', 'hydrated-disclosure': 'a',
	},
	listboxAndChoices: {
		'listbox-trigger': 'a', 'listbox-panel': 'a', 'listbox-runtime': 'a', 'choice-group': 'a', 'choice-index': 'a', 'choice-runtime': 'a',
	},
	documents: {
		'document-scope': 'a', 'device-document': 'a', 'device-style': 'a', 'device-body': 'a', 'device-selection': 'a',
		'device-visibility': 'a', 'device-unavailable': 'a', 'document-unavailable': 'a', 'selected-document': 'a',
		'selected-viewport': 'a', 'source-media': 'a',
		'desktop-document': 'c', 'mobile-document': 'c', 'desktop-only': 'c', 'mobile-only': 'c',
		/** Id suffix of the mobile copy (`<id>--data-blocks-engine-capture-mobile`). */
		mobile: 'i',
	},
	responsive: {
		'responsive-source': 'a', 'responsive-fragment': 'a', 'responsive-fragments': 'a', 'embedded-responsive': 'a', 'embedded-document': 'a',
		'anchor-fragment': 'a', 'anchor-target': 'a', 'anchor-source-id': 'a', 'anchor-alias': 'a', 'anchor-unresolved': 'a',
		'fluid-id': 'a', 'fluid-segment': 'a', 'fluid-rules': 'a', 'fluid-sheet-rules': 'a', 'fluid-ignore-padding': 'a', 'fluid-release': 'a', 'fluid-specificity': 'i',
		'geometry-id': 'a', 'visual-iframe-src': 'a', 'visual-iframe-width': 'a', 'visual-iframe-height': 'a',
	},
	collections: {
		collection: 'a', 'collection-item': 'a', 'collection-members': 'a', 'collection-category': 'a', 'collection-category-control': 'a',
		'collection-index': 'a', 'collection-mode': 'a', 'collection-field': 'a', 'collection-empty': 'a', 'collection-status': 'a',
		'collection-runtime': 'a', 'collection-visibility': 'a', 'status-template': 'a', 'status-hide-zero': 'a',
		'no-match': 't', 'no-match-7f39b2': 't', 'no-match-2c81e4': 't', 'finite-probe': 't', 'finite-probe-7f39b2': 't', 'finite-follow-up': 't',
	},
	galleries: {
		gallery: 'a', 'gallery-direction': 'a', 'gallery-index': 'a', 'gallery-initial': 'a', 'gallery-sequence': 'a', 'gallery-slot': 'a',
		'gallery-stage': 'a', 'gallery-source': 'a', 'gallery-frame': 'a', 'gallery-image': 'a', 'gallery-full-image': 'a', 'gallery-text': 'a',
		'gallery-display': 'a', 'gallery-close': 'a', 'gallery-capture-width': 'a', 'gallery-runtime': 'a', 'gallery-visibility': 'a',
		'captured-slide': 'a', 'captured-slideshow': 'a', 'captured-slide-count': 'a', 'advertised-slide-count': 'a', 'expected-slide-count': 'a',
		'capture-error': 'a', 'pager-stage': 'a', 'pager-control': 'a', 'video-frame': 'a', 'squarespace-video': 'a',
		slideshow: 'c', 'slideshow-track': 'c', 'slideshow-css': 'i', 'captured-slideshow-css': 'i', 'wix-captured-slideshow-css': 'i',
	},
	presentation: {
		'glyph-color': 'a', 'glyph-pending': 'a', 'glyph-probe': 'a', 'glyph-probe-candidate': 'a', 'glyph-probe-style': 'a',
		'native-control-state': 'a', 'native-control-runtime': 'a', 'native-effects': 'a', 'native-node': 'a', 'native-profile': 'a',
		'native-losses': 'a', 'native-runtime-loss': 'a', 'native-view-timeline-runtime': 'a',
		'viewport-entrance': 'a', 'viewport-entrances': 'a', 'viewport-entrance-loss': 'a', 'source-canvas': 'a',
		replica: 'c', 'content-desktop': 'c', 'content-mobile': 'c', 'content-mobile-inner': 'c',
	},
	platform: {
		'access-gate': 'a', 'member-login': 'a', 'engagement-stats': 'a', 'source-evidence': 'a', 'reclaimed-space': 'a', 'constructed-stylesheet': 'a',
		'ported-embed': 'a', 'unported-embed': 'a', 'squarespace-header-style': 'a', 'squarespace-header-visible': 'i', 'check-route-tab': 'a',
		'google-map-marker': 'a', 'google-map-embed': 'c',
	},
} as const;

/**
 * Name families whose tail is generated (after `CAPTURE_EVIDENCE_PREFIX`).
 * `<key>` marks the generated part.
 */
export const CAPTURE_EVIDENCE_FAMILIES = {
	'<profile>-document': 'c',
	'responsive-<hash>': 'c',
	'responsive-class-<hash>': 'c',
	'responsive-counterpart-<n>': 'c',
	'page-<slug>': 'c',
	'shared-<hash>': 'c',
	'embedded-<digest>-<document>': 'c',
	'member-login-<provider>': 'c',
	'engagement-stats-<provider>': 'c',
	'disclosure-open-<svg attribute>': 'a',
	'disclosure-closed-<svg attribute>': 'a',
	'dialog-<n>': 'i',
	'disclosure-panel-<n>': 'i',
	'gallery-<n>': 'i',
} as const;

/** Sidecar schemas, under `CAPTURE_SCHEMA_NAMESPACE`. */
export const CAPTURE_SCHEMAS = [
	'asset-evidence/v1', 'behavior-model/v1', 'candidate-motion/v1', 'capture-diagnostics/v1', 'capture-receipt/v1',
	'captured-interactions/v1', 'captured-scroll-states/v1', 'captured-semantic-evidence/v2',
	'collection-status/v1', 'compare-overlays/v1', 'embedded-documents/v1', 'engagement-stats/v1', 'export-publication-lock/v1', 'fidelity-reference/v1',
	'finite-bootstrap/v1', 'http-acquisition/v1', 'interaction-states/v1', 'interaction-states/v2', 'layout-geometry-capture/v1',
	'layout-geometry-proof/v1', 'learned-motion/v1', 'native-view-timelines/v1', 'portable-motion/v1', 'runtime-observations/v1',
	'runtime-regions/v1', 'scroll-states/v1', 'shopify-http-proof/v4', 'source-behavior/v1', 'source-behavior-report/v1',
	'source-capability-vocabulary/v1', 'source-cleanup/v8', 'source-interactivity/v1', 'source-outcome/v1', 'source-profile/v1',
] as const;

/**
 * sha256 of the trimmed bodies of capture runtimes a consumer recognizes by
 * identity. Blocks Engine retires the disclosure interpreter only when its
 * body hashes to `disclosure` (`CaptureEvidence::DISCLOSURE_RUNTIME_SHA256`,
 * published as php-transformer `tests/fixtures/capture-disclosure-runtime.js`;
 * contract: php-transformer docs/contracts/capture-evidence.md, "Recognized
 * capture runtimes"). `gallery` is the digest of this producer's gallery
 * helper; see docs/contracts/capture-evidence.md for its status upstream.
 */
export const CAPTURE_RUNTIME_SHA256 = {
	disclosure: 'b545f43a77b79d075373048431101fe11d7ff8cdfe7987de6d7971512763d88f',
	gallery: '456af76323601e51d851d3a4d6fe4ff6e3989c9969562f425fd72103c5c57c6b',
} as const;
