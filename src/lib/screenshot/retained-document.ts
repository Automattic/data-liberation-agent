/** Browser-safe snapshot repair. Never call on the live source document. */
export function normalizeRetainedDocument(snapshot: Element): void {
	const head = snapshot.querySelector('head');
	const body = snapshot.querySelector('body');
	if (!head || !body) return;
	const headTags = new Set('base basefont bgsound link meta title noscript noframes style script template'.split(' '));
	// Preserve source order while keeping parser-stable, stamped containers.
	const beforeBody: Element[] = [];
	const afterBody: Element[] = [];
	let seenBody = false;
	for (const child of Array.from(snapshot.children)) {
		if (child === body) seenBody = true;
		else if (child === head) beforeBody.push(...Array.from(head.children).filter(element => !headTags.has(element.localName)));
		else (seenBody ? afterBody : beforeBody).push(child);
	}
	body.prepend(...beforeBody);
	body.append(...afterBody);
}
