// src/lib/replicate/region-audit.ts
//
// Reconciles source landmarks against what the build placed (#2). Body sections
// join by selector; chrome joins by role; tiny/empty regions are non_actionable.
// An actionable landmark that maps to nothing is `unassigned` — the dropped-nav
// signal. Pure. See 2026-06-04-section-identifiers-design.md.
import type { SourceLandmark } from './section-extract.js';

export type RegionAssignmentKind =
  | 'page_body_section' | 'header_part' | 'footer_part' | 'non_actionable' | 'unassigned';

export interface RegionAssignment { landmark: SourceLandmark; kind: RegionAssignmentKind; }

export interface PlacedRegion {
  kind: 'page_body_section' | 'header_part' | 'footer_part';
  selector?: string;
  role?: 'header' | 'nav' | 'footer';
}

export interface RegionSelectionReport {
  page: string;
  entryUrl: string;
  assignments: RegionAssignment[];
  unassignedRegions: SourceLandmark[];
  counts: { sourceLandmarks: Record<string, number>; assigned: number; unassigned: number; nonActionable: number };
}

const ACTIONABLE_TEXT_MIN = 24;

function classify(l: SourceLandmark, placed: PlacedRegion[]): RegionAssignmentKind {
  if (l.textLength < ACTIONABLE_TEXT_MIN && l.mediaCount === 0) return 'non_actionable';
  const hasHeader = placed.some((p) => p.kind === 'header_part');
  const hasFooter = placed.some((p) => p.kind === 'footer_part');
  const bodySelectors = new Set(placed.filter((p) => p.kind === 'page_body_section').map((p) => p.selector));
  if ((l.role === 'header' || l.role === 'nav') && hasHeader) return 'header_part';
  if (l.role === 'footer' && hasFooter) return 'footer_part';
  if (l.role === 'main' || l.role === 'article') return bodySelectors.size > 0 ? 'page_body_section' : 'unassigned';
  if (bodySelectors.has(l.selector)) return 'page_body_section';
  return 'unassigned';
}

export function reconcileRegions(
  census: SourceLandmark[],
  placed: PlacedRegion[],
  page = '',
  entryUrl = '',
): RegionSelectionReport {
  const assignments = census.map((l) => ({ landmark: l, kind: classify(l, placed) }));
  const sourceLandmarks: Record<string, number> = {};
  for (const l of census) sourceLandmarks[l.role] = (sourceLandmarks[l.role] ?? 0) + 1;
  const unassignedRegions = assignments.filter((a) => a.kind === 'unassigned').map((a) => a.landmark);
  return {
    page, entryUrl, assignments, unassignedRegions,
    counts: {
      sourceLandmarks,
      assigned: assignments.filter((a) => ['page_body_section', 'header_part', 'footer_part'].includes(a.kind)).length,
      unassigned: unassignedRegions.length,
      nonActionable: assignments.filter((a) => a.kind === 'non_actionable').length,
    },
  };
}
