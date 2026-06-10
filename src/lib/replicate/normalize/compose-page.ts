// src/lib/replicate/normalize/compose-page.ts
import { composeInstantiate, type LayoutSkeleton } from '../compose-instantiate.js';
import { blockMarkupRoundtrips } from '../../streaming/block-markup-validate.js';
import { segmentPage } from './segment.js';
import { emitSectionBlocks } from './emit-blocks.js';
import type { LocalPage, NormalizeReportEntry } from '../local-site/types.js';

export interface ComposePageResult {
  postContent: string;
  report: NormalizeReportEntry[];
}

export function composePage(page: LocalPage): ComposePageResult {
  const bodySections = segmentPage(page.html).filter((s) => s.role === 'body');
  if (bodySections.length === 0) return { postContent: '', report: [] };

  const skeleton: LayoutSkeleton = { sections: [] };
  const pageContent: Record<string, string> = {};
  const report: NormalizeReportEntry[] = [];

  for (const section of bodySections) {
    const { markup, confidence } = emitSectionBlocks(section);
    skeleton.sections.push({ type: 'content', slots: [section.id] });
    pageContent[section.id] = markup;
    report.push({ sectionId: section.id, blockType: 'group', confidence });
  }

  const composed = composeInstantiate(skeleton, pageContent, {});
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
