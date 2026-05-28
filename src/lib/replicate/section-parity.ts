// src/lib/replicate/section-parity.ts
// Per-section visual-parity contract — the unit the faithful-recreation gate keys on.
// Pure: status derivation only. The SCORER that fills `signals` from rendered DOM /
// sampled pixels (and computes `columnCountMatch`) is the section-rebuild *capability*
// spec; this module defines what "matches the source" MEANS, measured, and who may
// accept a divergence. See docs/superpowers/specs/2026-05-28-enforce-faithful-recreation-design.md.

/** CIE2000 ΔE above which a section's background color counts as a real divergence.
 *  Start at 10 (clearly-different color); tune from QA evidence like TEXT_FLOOR. */
export const BG_DELTA_E_FLOOR = 10;

/** Robust structural signals — chosen because they survive the font-substitution and
 *  text-reflow noise that makes whole-section pixel-diff unreliable, and because they are
 *  exactly the observed flatten failures (bg color, column count, dropped section/media,
 *  unstyled island). */
export interface SectionParitySignals {
  /** Replica did NOT drop or merge this section away. */
  sectionPresent: boolean;
  /** CIE2000 ΔE of the band background, source vs replica. */
  bgDeltaE: number;
  /** 3-card grid stayed 3; a 2-column band stayed 2. (Capability spec computes from DOM;
   *  defaults true until then so the gate never falsely blocks on an unimplemented signal.) */
  columnCountMatch: boolean;
  /** Captured image(s) present and placed in the band. */
  mediaPresent: boolean;
  /** A core/html fallback island landed on a CSS-LAYOUT section (carries HTML, not CSS →
   *  renders unstyled). A text-only island does NOT set this. */
  fallbackUnstyled: boolean;
}

export type DivergenceReason =
  | 'section-dropped'
  | 'bg-color'
  | 'column-flatten'
  | 'media-dropped'
  | 'unstyled-island';

/** Reasons that are always FIXABLE, never a genuine WP/source rendering constraint —
 *  so the agent may not self-accept them as Class C. Under the current signal set this
 *  is every reason, so class-c acceptance never validly applies to a detected divergence;
 *  a true sub-threshold WP constraint does not trip these signals (it stays `match` with a
 *  pixel-delta note the agent may annotate). Accepting a real divergence is the operator's call. */
const NEVER_CLASS_C: ReadonlySet<DivergenceReason> = new Set<DivergenceReason>([
  'section-dropped',
  'bg-color',
  'column-flatten',
  'media-dropped',
  'unstyled-island',
]);

/** Who accepted a divergent section, and the evidence. */
export interface SectionAcceptance {
  by: 'human' | 'class-c';
  /** Required, non-empty: operator rationale, or sampled-pixel proof for class-c. */
  proof: string;
}

export type SectionStatus = 'match' | 'divergent' | 'accepted';

export interface SectionParity {
  /** Section id / Y-band label. */
  band: string;
  signals: SectionParitySignals;
  /** 0..10 gap-to-target score (for the human report; the verdict re-derives status). */
  score: number;
  status: SectionStatus;
  /** Sampled pixels backing the score — "prove it works": no pass without evidence. */
  evidence: { srcSample: string; repSample: string };
  acceptance?: SectionAcceptance;
}

/** Which robust signals tripped. Empty → the section matches the source. */
export function divergenceReasons(s: SectionParitySignals): DivergenceReason[] {
  const reasons: DivergenceReason[] = [];
  if (!s.sectionPresent) reasons.push('section-dropped');
  if (s.bgDeltaE > BG_DELTA_E_FLOOR) reasons.push('bg-color');
  if (!s.columnCountMatch) reasons.push('column-flatten');
  if (!s.mediaPresent) reasons.push('media-dropped');
  if (s.fallbackUnstyled) reasons.push('unstyled-island');
  return reasons;
}

function isAcceptanceValid(acceptance: SectionAcceptance, reasons: DivergenceReason[]): boolean {
  if (!acceptance.proof.trim()) return false; // schema-locked: no blank sign-offs
  if (acceptance.by === 'human') return true; // operator may sign off on any divergence
  // class-c: a genuine WP/source constraint — never valid for a fixable structural reason.
  return reasons.every((r) => !NEVER_CLASS_C.has(r));
}

/** The single source of truth for a section's status. The run-report verdict re-derives
 *  from `signals` + `acceptance` rather than trusting a stored `status`, so prose can't
 *  override the measured table. */
export function deriveSectionParityStatus(
  signals: SectionParitySignals,
  acceptance?: SectionAcceptance,
): SectionStatus {
  const reasons = divergenceReasons(signals);
  if (reasons.length === 0) return 'match';
  if (acceptance && isAcceptanceValid(acceptance, reasons)) return 'accepted';
  return 'divergent';
}
