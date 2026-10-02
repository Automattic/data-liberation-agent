import type { AnyNode, Element } from 'domhandler';

/** Hydration ids a builder runtime writes. They name a capture, not a component. */
export const YUI_RUNTIME_ID = /yui_/i;

export function isYuiRuntimeId( id: string ): boolean {
	return YUI_RUNTIME_ID.test( id );
}

export function isElementNode( node: AnyNode ): node is Element {
	return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}
