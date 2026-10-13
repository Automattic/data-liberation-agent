/**
 * Default decoded source-document admission shared by HTTP acquisition and
 * browser navigation. Redirect inspection must see the complete admitted HTML
 * (including late active refresh declarations), not a truncated evidence prefix.
 * HTTP acquisition callers may explicitly supply their own document ceiling.
 */
export const SOURCE_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
