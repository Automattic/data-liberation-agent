// src/lib/replicate/normalize/compose-page.ts
import { composeInstantiate, type LayoutSkeleton } from '../compose-instantiate.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';
import { segmentPage } from './segment.js';
import { emitSectionBlocks } from './emit-blocks.js';
import type { LocalPage, NormalizeReportEntry, RevealBehavior, Section, SectionBehavior } from '../local-site/types.js';

export interface ComposePageResult {
  postContent: string;
  report: NormalizeReportEntry[];
}

export interface ComposePageOpts {
  /** nativeBehaviors: tag every body section with the detected reveal. The
   * source observed document.querySelectorAll('section') — all sections —
   * so tagging is uniform, mirroring source semantics exactly. */
  reveal?: RevealBehavior;
  /** B1: per-section DOM-pattern detection callback (inversion — compose-page
   * gains no detection imports; the handler closes over the source assets).
   * A specific behavior (tabs/slider/modal) beats the uniform reveal: one
   * behavior per section (the wrapper block is singular). Runs on BOTH paths
   * — tagging guarantees verbatim inner (content survival); `native` decides
   * the wrapper. */
  detectSection?: (s: Section) => SectionBehavior | undefined;
  /** nativeBehaviors path marker. true → tagged sections emit the dla/<kind>
   * directive wrapper; false/absent (carry/default) → the SAME verbatim inner
   * rides a plain core/group wrapper (no plugin dependency; the carried
   * source JS drives the intact DOM). reveal is caller-gated to native. */
  native?: boolean;
}

export function composePage(page: LocalPage, opts: ComposePageOpts = {}): ComposePageResult {
  const native = opts.native === true;
  const bodySections = segmentPage(page.html)
    .filter((s) => s.role === 'body')
    .map((s) => {
      const sectionBehavior = opts.detectSection?.(s);
      // Specific per-section behavior beats the uniform reveal (one wrapper).
      if (sectionBehavior) return { ...s, behavior: sectionBehavior };
      return opts.reveal ? { ...s, behavior: opts.reveal } : s;
    });
  // Genuinely empty page: nothing to validate, skip the roundtrip gate.
  if (bodySections.length === 0) return { postContent: '', report: [] };

  const skeleton: LayoutSkeleton = { sections: [] };
  const pageContent: Record<string, string> = {};
  const report: NormalizeReportEntry[] = [];

  for (const section of bodySections) {
    const { markup, confidence } = emitSectionBlocks(section, {
      behaviorWrapper: native ? 'dla' : 'group',
    });
    skeleton.sections.push({ type: 'content', slots: [section.id] });
    pageContent[section.id] = markup;
    // blockType reflects the WRAPPER EMITTED: carry-tagged sections wrap as
    // plain groups (per-kind counts stay native-only by construction). The
    // reveal branch always emits dla/reveal — reveal is caller-gated to native.
    const blockType =
      section.behavior && (native || section.behavior.kind === 'reveal')
        ? `dla/${section.behavior.kind}`
        : 'group';
    report.push({ sectionId: section.id, blockType, confidence });
  }

  const composed = composeInstantiate(skeleton, pageContent, {});
  // Unreachable today (every slot is filled with non-empty group markup) —
  // fence against future composeInstantiate changes causing silent partial loss.
  if (composed.misfit) {
    throw new Error(`compose mismatch for "${page.slug}": ${JSON.stringify(composed.sanity)}`);
  }
  // Strip composeInstantiate's "<!-- section:type -->" marker lines; keep only block markup.
  const postContent = composed.postContent
    .split('\n')
    .filter((line) => !/^<!--\s*section:/.test(line))
    .join('\n')
    .trim();

  const check = blockMarkupRoundtrips(postContent);
  if (!check.ok) {
    throw new Error(`composed markup for "${page.slug}" failed roundtrip: ${check.reason}`);
  }
  return { postContent, report };
}
