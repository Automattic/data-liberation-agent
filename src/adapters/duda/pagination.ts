import type { Page } from 'playwright';

/**
 * Mark a Duda blog-list pager that has only one page as inert.
 *
 * Duda renders its pager links without an href:
 *   <nav class="pagination-nav"><ul>
 *     <li><a data-page="1" data-action="paginate" class="pagination-link disabled">‹</a></li>
 *     <li><a data-page="1" data-action="paginate" class="pagination-link active">1</a></li>
 *     <li><a data-page="1" data-action="paginate" class="pagination-link disabled">›</a></li>
 *   </ul></nav>
 * Activating a link asks Duda's runtime to re-render the widget at `data-page`.
 * When every link targets the active page, each one re-renders the page already
 * shown, so the static copy loses no behavior. Those links get the capture
 * inert-control evidence. A pager with more than one page is left untouched.
 */
export function markSinglePagePagers(): number {
	let marked = 0;
	for (const pager of document.querySelectorAll('nav.pagination-nav')) {
		const links = Array.from(pager.querySelectorAll('a[data-action="paginate"]'));
		const active = links.filter(link => link.classList.contains('active'));
		if (active.length !== 1) continue;
		const page = active[0].getAttribute('data-page');
		if (!page || links.some(link => link.getAttribute('data-page') !== page)) continue;
		for (const link of links) {
			link.setAttribute('data-blocks-engine-capture-inert-control', 'true');
			marked++;
		}
	}
	return marked;
}

export async function markInertPagers(page: Page): Promise<number> {
	return page.evaluate(markSinglePagePagers);
}
