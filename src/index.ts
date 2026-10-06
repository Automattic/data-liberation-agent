// src/index.ts
//
// The PUBLIC package entry — the import surface third-party consumers use:
//
//   import { registerPlatform, detectPlatform } from 'data-liberation';
//
// The product operations and their extension registries share this entry.
// Package imports and the standalone runtime bundle use the same contract;
// orchestration and destination acceptance policy belong to the consumer.

// Importing the entry registers the built-in platforms (and the generic
// fallback) in the same registry consumer platforms join.
import './platform/builtins.js';

export {
	registerPlatform,
	registeredPlatforms,
	findPlatform,
	fallbackPlatform,
	resolvePlatform,
	UNKNOWN_PLATFORM_ID,
	PlatformRegistrationError,
	InvalidPlatformError,
	DuplicatePlatformError,
	ConflictingFallbackError,
} from './platform/registry.js';

export { registerHost, registeredHosts, unregisterHost, detectHosts, hostResidue, HostRegistrationError } from './platform/host.js';
export type { Host, HostDetection, HostResidueRule, DetectedHost } from './platform/host.js';

export { detect as detectPlatform, detectFromUrl, detectFromHttp } from './lib/detect-platform/index.js';
export { inspectSource, InspectError, INSPECTION_SCHEMA_VERSION } from './lib/inspect.js';
export { captureWebsite, UnsupportedCapturePlatformError, IncompleteCaptureError } from './lib/capture.js';
export type { CaptureOptions, CaptureResult, CaptureProgress, CaptureDependencies, UnresolvedAnchor } from './lib/capture.js';
export type { HttpCaptureOptions } from './lib/capture-http.js';
export { acquireHttpDocuments } from './lib/http-acquisition.js';
export type { HttpAcquisitionOptions, AcquiredHttpDocument } from './lib/http-acquisition.js';
export type { HttpAcquisitionProfile, HttpDocumentContext, PreparedHttpDocument, RuntimeRegionRequirement } from './platform/acquisition.js';
export { checkFidelity } from './lib/fidelity/check.js';
export { serveCapture } from './lib/serve-capture.js';
export type { StaticServer as CapturePreviewServer } from './lib/replicate/local-site/static-server.js';
export type { FidelityCheckOptions, FidelityReport, RouteScore, ObservePair } from './lib/fidelity/check.js';
export type { FidelityStage, FidelityReference, ReferenceEntry, ReferenceArtifact } from './lib/fidelity/reference.js';
export type { MotionContract, MotionEvidence } from './lib/fidelity/candidate-motion.js';
export { authorPortableMotion } from './lib/portable-motion.js';
export type { PortableMotionRecipe, PortableMotionReceipt } from './lib/portable-motion.js';
export type {
	DetectionResult,
	FullDetectionResult,
} from './lib/detect-platform/index.js';

export type {
	Platform,
	PlatformDetection,
	PlatformUrlSignal,
	PlatformHttpSignal,
	PlatformSourceSignal,
	PlatformPathProbe,
	RegisterPlatformOptions,
} from './platform/types.js';
export type { LiberationHooks, LiberationContext } from './adapters/page-actions.js';
export { cleanupPolicy, providerCreditRules, CLEANUP_SCHEMA } from './lib/source-cleanup.js';
export type { CleanupRule, CleanupPolicy, CleanupReport, CleanupRecord } from './lib/source-cleanup.js';
export { registerPublishTarget, unregisterPublishTarget, findPublishTarget, publishTargetNames, PublishError } from './lib/publish/index.js';
export type { PublishTarget, PublishOptions, PublishResult } from './lib/publish/types.js';
export { publishSite } from './ui/publish.js';
export type { PublishCliOptions as PublishSiteOptions } from './ui/publish.js';
export type { InspectOptions, InspectionIssue, SourceInspection } from './lib/inspect.js';
export { SOURCE_CAPABILITIES, SOURCE_CAPABILITY_VOCABULARY } from './lib/inspect-rendered.js';
export type { CapabilityRule, SourceCapability, RenderedInspection, SourceComplexity, ExcludedSurface } from './lib/inspect-rendered.js';
export { materializeHttpDocuments, type HttpMaterializationOptions } from './lib/http-materialization.js';
export { observeRuntimeRegions } from './lib/runtime-regions.js';
export type { RuntimeRegionNode, RuntimeRegionObservation } from './lib/runtime-regions.js';
export { stageRuntimeRegions } from './lib/embedded-documents.js';
export type { RuntimeRegionAttachment } from './lib/embedded-documents.js';
