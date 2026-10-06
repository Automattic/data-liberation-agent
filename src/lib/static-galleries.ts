import * as cheerio from 'cheerio';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';
import type { CapturedGallery } from './screenshot/gallery-capture.js';

const RUNTIME = `(function(){
function all(selector,root){return Array.prototype.slice.call((root||document).querySelectorAll(selector));}
function frames(root){return all('[data-dla-gallery-frame]',root).filter(function(node){return node.closest('[data-dla-gallery]')===root;});}
function set(root,index){var items=frames(root),frame=items[index];if(!frame)return;root.setAttribute('data-dla-gallery-index',String(index));items.forEach(function(node){node.hidden=node!==frame;});var text=JSON.parse(frame.getAttribute('data-dla-gallery-text')||'[]');text.forEach(function(record){var node=root.querySelector(record.selector);if(node)node.textContent=record.value;});}
function activate(event){var control=event.target.closest&&event.target.closest('[data-dla-gallery-direction]');if(control){var root=control.closest('[data-dla-gallery]');if(!root)return;event.preventDefault();event.stopPropagation();var size=frames(root).length,index=Number(root.getAttribute('data-dla-gallery-index'));set(root,(index+Number(control.getAttribute('data-dla-gallery-direction'))+size)%size);return;}
var stage=event.target.closest&&event.target.closest('[data-dla-gallery-stage][data-dla-dialog-trigger]');if(!stage||!event.target.closest('img'))return;var owner=stage.closest('[data-dla-gallery]'),panel=document.getElementById(stage.getAttribute('aria-controls'));if(!owner||!panel)return;var overlay=panel.querySelector('[data-dla-gallery]'),items=frames(owner),selected=items[Number(owner.getAttribute('data-dla-gallery-index'))],identity=selected&&selected.getAttribute('data-dla-gallery-full-image');var target=overlay&&frames(overlay).findIndex(function(frame){return frame.getAttribute('data-dla-gallery-image')===identity;});if(overlay&&target>=0)set(overlay,target);}
document.addEventListener('click',activate,true);
})();`;

function wire($: cheerio.CheerioAPI, gallery: CapturedGallery, fullImages: boolean): boolean {
	if (gallery.coverage !== 'complete' || gallery.restoration !== 'verified') return false;
	let wired = false;
	$(gallery.selector).each((_, element) => {
		const root = $(element),
			stage = root.find(gallery.stage.replace(':scope', ''));
		const next = root.find(gallery.next.replace(':scope', '')),
			previous = root.find(gallery.previous.replace(':scope', ''));
		if (stage.length !== 1 || next.length !== 1 || previous.length !== 1) return;
		const matching = stage.children().filter((__, child) =>
			gallery.frames.some((frame) => {
				const observed = cheerio.load(frame.html, null, false).root().children().first();
				return (
					observed.attr('class') === $(child).attr('class') &&
					observed.find('img').first().attr('src') === $(child).find('img').first().attr('src')
				);
			}),
		);
		const initialImage =
			matching.length === 1 ? matching.find('img').first().attr('src') : undefined;
		let initial = gallery.frames.findIndex((frame) => frame.key === initialImage);
		if (initial < 0) initial = gallery.initial;
		stage.empty();
		gallery.frames.forEach((frame, index) => {
			const fragment = cheerio.load(frame.html, null, false);
			const child = fragment.root().children().first();
			child
				.attr('data-dla-gallery-frame', String(index))
				.attr('data-dla-gallery-image', frame.key)
				.attr('data-dla-gallery-text', JSON.stringify(frame.text));
			const fullImage = child.find('[data-src]').first().attr('data-src');
			if (fullImage) child.attr('data-dla-gallery-full-image', fullImage);
			if (index !== initial) child.attr('hidden', '');
			else child.removeAttr('hidden');
			stage.append(fragment.html());
		});
		root.attr('data-dla-gallery', '').attr('data-dla-gallery-index', String(initial));
		stage.attr('data-dla-gallery-stage', '');
		next.attr('data-dla-gallery-direction', '1');
		previous.attr('data-dla-gallery-direction', '-1');
		if (fullImages) root.find('[aria-label*="Close" i]').attr('data-dla-gallery-close', '');
		wired = true;
	});
	return wired;
}

export function wireCapturedGalleries(html: string, states: CapturedDialogInteraction[]): string {
	const captured = states.filter(
		state => state.kind === 'gallery' && state.status === 'captured' && state.gallery && !state.dialog?.htmlTruncated
	);
	if (captured.length === 0) return html;
	const $ = cheerio.load(html);
	let wired = false;
	for (const state of captured)
		if (
			state.kind === 'gallery' &&
			state.status === 'captured' &&
			state.gallery &&
			!state.dialog?.htmlTruncated
		)
			wired = wire($, state.gallery.inline, false) || wired;
	if (wired) {
		$('head').append(
			'<style data-dla-gallery-visibility>[data-dla-gallery-frame][hidden]{display:none!important}[data-dla-gallery-frame]:not([hidden]){display:block!important;visibility:visible!important;opacity:1!important}</style>',
		);
		$('head').append(`<script data-dla-gallery-runtime>${RUNTIME}</script>`);
	}
	return wired ? $.html() : html;
}

export function wireGalleryDialog(html: string, gallery: CapturedGallery, panelId: string): string {
	const $ = cheerio.load(html, null, false);
	wire($, gallery, true);
	$('[data-dla-gallery-close]').attr('data-dla-dialog-close', panelId);
	return $.html();
}
