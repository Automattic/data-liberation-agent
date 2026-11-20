import type { SrcsetCandidate } from './srcset.js';

/** Shared dimension ceiling for capture representatives and portable export. */
export const MAX_PORTABLE_MEDIA_DIMENSION = 2048;

/** Shared per-file byte ceiling for a portable media file outside a responsive family. */
export const MAX_PORTABLE_MEDIA_BYTES = 5 * 1024 * 1024;

/** Prefer a known portable width; density-only candidates have no pixel bound. */
export function portableSrcsetRepresentative(candidates: readonly SrcsetCandidate[]): SrcsetCandidate | undefined {
	// Width descriptors alone understate portrait originals. Rendition suffixes
	// in this same srcset supply the aspect ratio for suffixless originals.
	const heightRatio = Math.max(1, ...candidates.map(candidate => {
		const suffix = candidate.url.split(/[?#]/, 1)[0].match(/-(\d+)x(\d+)\.[^./]+$/);
		return suffix ? Number(suffix[2]) / Number(suffix[1]) : 1;
	}));
	const bounded = candidates.filter(candidate => {
		const suffix = candidate.url.split(/[?#]/, 1)[0].match(/-(\d+)x(\d+)\.[^./]+$/);
		const dimension = Math.max(
			candidate.density ? 0 : candidate.size * (suffix ? 1 : heightRatio),
			...(suffix ? [Number(suffix[1]), Number(suffix[2])] : [0])
		);
		return dimension <= MAX_PORTABLE_MEDIA_DIMENSION;
	});
	return (bounded.length ? bounded : candidates).reduce<SrcsetCandidate | undefined>(
		(widest, candidate) => !widest || candidate.size > widest.size ? candidate : widest,
		undefined
	);
}

/** Captured responsive renditions kept per image beside its representative. */
export const MAX_PORTABLE_CAPTURED_RENDITIONS = 3;

/**
 * Bound an image's captured responsive renditions: renditions above the
 * dimension ceiling are never portable, and the rest keep a width-spread set of
 * at most `limit`. Aliases without a known width (independent crops or files)
 * are kept. Dropped renditions fall back to the image's representative.
 */
export function boundedResponsiveRenditions(urls: readonly string[], widths: Readonly<Record<string, number>> = {}, limit = MAX_PORTABLE_CAPTURED_RENDITIONS): string[] {
	const sized = urls.filter(url => widths[url] !== undefined && widths[url] <= MAX_PORTABLE_MEDIA_DIMENSION)
		.sort((a, b) => widths[a] - widths[b] || a.localeCompare(b));
	const step = sized.length > limit ? (sized.length - 1) / Math.max(1, limit - 1) : 1;
	const kept = new Set(sized.length > limit ? Array.from({ length: limit }, (_, index) => sized[Math.round(index * step)]) : sized);
	return urls.filter(url => widths[url] === undefined || kept.has(url));
}
