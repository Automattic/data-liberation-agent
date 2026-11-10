import type { AnyNode, Element } from 'domhandler';

/** Hydration ids a builder runtime writes. They name a capture, not a component. */
export const YUI_RUNTIME_ID = /yui_/i;

/** One whole runtime ID token, bounded so a shorter ID never matches a longer one. */
export const RUNTIME_ID_TOKEN = /(?<![\w-])yui_[\w-]*\d(?![\w-])/;

export function isYuiRuntimeId( id: string ): boolean {
	return YUI_RUNTIME_ID.test( id );
}

export function isElementNode( node: AnyNode ): node is Element {
	return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}
