import { parse } from '@wordpress/block-serialization-default-parser';
import { walkBlocks } from '../block-tree.js';
import type { ParsedBlock } from '../block-tree.js';
import { analyzeIsland, emitEditableBlock } from './island-bindings.js';

interface Replacement {
  from: string;
  to: string;
}

function originalHtmlBlock(block: ParsedBlock): string {
  return `<!-- wp:html -->${block.innerHTML}<!-- /wp:html -->`;
}

function containsBlockDelimiter(html: string): boolean {
  return /<!--\s*\/?wp:/.test(html);
}

export function makeIslandsEditable(postContent: string): { content: string; converted: number } {
  const replacements: Replacement[] = [];

  walkBlocks(parse(postContent), (block) => {
    if (block.blockName !== 'core/html') return;
    if (containsBlockDelimiter(block.innerHTML)) return;

    const island = analyzeIsland(block.innerHTML);
    if (island.bindingCount === 0) return;

    replacements.push({
      from: originalHtmlBlock(block),
      to: emitEditableBlock(island),
    });
  });

  let content = postContent;
  let converted = 0;
  for (const replacement of replacements) {
    if (!content.includes(replacement.from)) continue;
    content = content.replace(replacement.from, () => replacement.to);
    converted += 1;
  }

  return { content, converted };
}
