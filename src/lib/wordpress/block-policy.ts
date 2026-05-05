const CUSTOM_HTML_BLOCK_RE = /<!--\s*\/?\s*wp:(?:core\/)?html(?:\s|\/?-->)/i;

export function containsCustomHtmlBlock(markup: string): boolean {
  return CUSTOM_HTML_BLOCK_RE.test(markup);
}

export function customHtmlBlockError(context: string): string {
  return `${context} contains a Custom HTML block. Use existing WordPress core blocks first; create a custom block when needed, and move CSS into style.css instead of wp:html.`;
}
