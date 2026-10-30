import type { SrcsetCandidate } from './srcset.js';

/** Shared dimension ceiling for capture representatives and portable export. */
export const MAX_PORTABLE_MEDIA_DIMENSION = 2048;

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
