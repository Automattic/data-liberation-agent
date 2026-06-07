//
// Block fixer — ported from
// https://github.com/Automattic/telex (server/scripts/block-fixer/lib/blockFixer.js).
//
// parse() applies validation-fixes automatically; createBlock() + serialize()
// re-emits canonical WordPress markup. Even "valid" blocks get re-serialized
// because subtle structural differences (attribute order, missing data-attrs,
// CSS property order) can still fail WordPress's block validator.
//

const { parse, serialize, createBlock } = require('@wordpress/blocks');
const { registerCoreBlocks } = require('@wordpress/block-library');
const { fixNestedParagraphs } = require('./paragraphFixer');

let initialized = false;

function initializeBlockRegistry() {
  if (initialized) return;
  try {
    registerCoreBlocks();
    initialized = true;
    console.error('[BlockFixer] Block registry initialized with core blocks');
  } catch (error) {
    console.error('[BlockFixer] Failed to initialize block registry:', error);
    initialized = true;
  }
}

function fixBlockRecursively(block) {
  const fixedInnerBlocks = [];

  if (block.innerBlocks && block.innerBlocks.length > 0) {
    for (const innerBlock of block.innerBlocks) {
      const result = fixBlockRecursively(innerBlock);
      fixedInnerBlocks.push(result.block);
    }
  }

  if (!block.name) {
    return { block, wasFixed: false };
  }

  const fixedBlock = createBlock(
    block.name,
    block.attributes,
    fixedInnerBlocks.length > 0 ? fixedInnerBlocks : undefined,
  );

  return { block: fixedBlock, wasFixed: true };
}

function fixBlocksInTemplate(htmlContent) {
  initializeBlockRegistry();

  try {
    const preFixedContent = fixNestedParagraphs(htmlContent);
    const blocks = parse(preFixedContent);

    const fixedIssues = [];
    const collectIssues = (blockList) => {
      for (const block of blockList) {
        if (!block.isValid) {
          const blockName = block.name || 'unknown';
          const blockIssues = block.validationIssues || [];
          if (blockIssues.length > 0) {
            for (const i of blockIssues) {
              let msg;
              if (typeof i === 'string') {
                msg = i;
              } else if (typeof i.message === 'string') {
                msg = i.message;
              } else if (Array.isArray(i.args) && typeof i.args[0] === 'string') {
                const template = i.args[0];
                const values = i.args.slice(1).map((v) => {
                  if (typeof v === 'string') return v;
                  if (Array.isArray(v) && v.every(Array.isArray)) {
                    return '[' + v.map((attr) => attr[0]).join(', ') + ']';
                  }
                  if (typeof v === 'object' && v !== null) return '{...}';
                  return String(v);
                });
                msg = template;
                values.forEach((v) => {
                  msg = msg.replace(/%[os]/, v);
                });
              } else {
                msg = JSON.stringify(i);
              }
              fixedIssues.push(`${blockName}: ${msg}`);
            }
          } else {
            fixedIssues.push(`${blockName}: Block marked as invalid`);
          }
        }
        if (block.innerBlocks && block.innerBlocks.length > 0) {
          collectIssues(block.innerBlocks);
        }
      }
    };
    collectIssues(blocks);

    const fixedBlocks = blocks.map((block) => fixBlockRecursively(block).block);

    let fixedHtml = serialize(fixedBlocks);

    const beforeParaFix = fixedHtml;
    fixedHtml = fixNestedParagraphs(fixedHtml);
    if (preFixedContent !== htmlContent || fixedHtml !== beforeParaFix) {
      fixedIssues.push('core/paragraph: Nested paragraph tags detected and removed');
    }

    const wasChanged = fixedHtml !== preFixedContent;

    if (fixedIssues.length > 0) {
      console.error(`[BlockFixer] Found ${fixedIssues.length} invalid block(s)`);
      for (const issue of fixedIssues) {
        console.error(`  - ${issue}`);
      }
    }

    if (wasChanged) {
      console.error(`[BlockFixer] HTML normalized (re-serialized ${blocks.length} block(s))`);
    }

    return {
      html: fixedHtml,
      changed: wasChanged,
      fixedIssues,
    };
  } catch (error) {
    console.error('[BlockFixer] Error fixing blocks:', error);
    return {
      html: htmlContent,
      changed: false,
      fixedIssues: [],
    };
  }
}

module.exports = {
  initializeBlockRegistry,
  fixBlocksInTemplate,
  fixNestedParagraphs,
};
