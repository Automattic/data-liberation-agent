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
   * behavior per section (the wrapper block is singular). */
  detectSection?: (s: Section) => SectionBehavior | undefined;
}

export function composePage(page: LocalPage, opts: ComposePageOpts = {}): ComposePageResult {
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
    const { markup, confidence } = emitSectionBlocks(section);
    skeleton.sections.push({ type: 'content', slots: [section.id] });
    pageContent[section.id] = markup;
    report.push({
      sectionId: section.id,
      blockType: section.behavior ? `dla/${section.behavior.kind}` : 'group',
      confidence,
    });
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
