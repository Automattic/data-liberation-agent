// src/lib/replicate/responsive-check.ts
// The HARD responsiveness acceptance gate, expressed as a pure function over
// metrics measured from a deployed replica at 390px: (1) no horizontal overflow,
// (2) every section reflowed (none stayed at desktop width). A 1px tolerance
// absorbs sub-pixel rounding.
export interface ResponsiveMetrics {
  scrollWidth: number;
  viewportWidth: number;
  sectionsTotal: number;
  sectionsReflowed: number;
}
export interface ResponsiveResult { ok: boolean; reasons: string[]; }

export function evaluateResponsive(m: ResponsiveMetrics): ResponsiveResult {
  const reasons: string[] = [];
  if (m.scrollWidth > m.viewportWidth + 1) {
    reasons.push(`horizontal overflow: scrollWidth ${m.scrollWidth} > viewport ${m.viewportWidth}`);
  }
  if (m.sectionsReflowed < m.sectionsTotal) {
    reasons.push(`${m.sectionsTotal - m.sectionsReflowed} of ${m.sectionsTotal} sections did not reflow`);
  }
  return { ok: reasons.length === 0, reasons };
}
