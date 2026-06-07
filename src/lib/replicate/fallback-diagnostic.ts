// src/lib/replicate/fallback-diagnostic.ts
//
// Structured, machine-actionable record for a coverage-gated core/html island
// (#1). Turns "N sections fell back" into "section X fell back because of dropped
// media; repair = recover_dropped_media" — readable by the reconstruction agent.
// Pure; warning-level. See 2026-06-04-section-identifiers-design.md.
import type { SectionSpec } from './section-extract.js';
import type { CoverageResult } from './section-coverage.js';

export type FallbackReasonCode = 'dropped_images' | 'text_coverage_below_floor';
export type FallbackRepairClass = 'recover_dropped_media' | 'restructure_section_blocks';

export interface FallbackDiagnostic {
  id: string;
  page: string;
  sectionIndex: number;
  interactionModel: string;
  selector: string;
  severity: 'warning';
  reasonCode: FallbackReasonCode;
  islandKind: 'verbatim' | 'styled' | 'responsive';
  droppedImages: string[];
  textCoverage: number;
  suggestedRepairClass: FallbackRepairClass;
  sourceHtmlPreview: string;
  emittedBlockPreview: string;
}

const PREVIEW = 200;

export function buildFallbackDiagnostic(args: {
  page: string;
  slug: string;
  section: SectionSpec;
  coverage: CoverageResult;
  islandKind: 'verbatim' | 'styled' | 'responsive';
  islandMarkup: string;
}): FallbackDiagnostic {
  const { page, slug, section, coverage, islandKind, islandMarkup } = args;
  const reasonCode: FallbackReasonCode =
    coverage.missingImages.length > 0 ? 'dropped_images' : 'text_coverage_below_floor';
  const suggestedRepairClass: FallbackRepairClass =
    reasonCode === 'dropped_images' ? 'recover_dropped_media' : 'restructure_section_blocks';
  const sourceHtmlPreview = ((section.styledHtml ?? section.sectionHtml ?? '') as string).slice(0, PREVIEW);
  return {
    id: `${slug}-s${section.sectionIndex}-${reasonCode}`,
    page,
    sectionIndex: section.sectionIndex,
    interactionModel: String(section.interactionModel),
    selector: section.selector ?? '',
    severity: 'warning',
    reasonCode,
    islandKind,
    droppedImages: coverage.missingImages,
    textCoverage: Math.round(coverage.textCoverage * 100) / 100,
    suggestedRepairClass,
    sourceHtmlPreview,
    emittedBlockPreview: islandMarkup.slice(0, PREVIEW),
  };
}
