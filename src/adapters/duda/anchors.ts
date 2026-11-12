import type { Page } from 'playwright';

/** Preserve Duda's runtime anchor destinations in the static document. */
export function materializeAnchorIds(): void {
	for (const element of document.querySelectorAll('[data-anchor]')) {
		if (element.hasAttribute('id')) continue;
		const id = element.getAttribute('data-anchor')!.replace(/\s/g, '');
		if (id && !document.getElementById(id)) element.id = id;
	}
}

export async function resolveAnchorTargets(page: Page): Promise<void> {
	await page.evaluate(materializeAnchorIds);
}
