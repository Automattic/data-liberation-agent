/** Compare authored markup without capture's persistent source-element identities. */
export function stripNodeIds(html: string): string {
	return html.replace(/\sdata-blocks-engine-node-id="[A-Za-z0-9._:-]+"/g, '');
}
