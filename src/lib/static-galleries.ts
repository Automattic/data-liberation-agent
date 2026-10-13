import * as cheerio from 'cheerio';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';
import type { CapturedGallery } from './screenshot/gallery-capture.js';

const RUNTIME = `(function(){
function all(selector,root){return Array.prototype.slice.call((root||document).querySelectorAll(selector));}
function frames(root){return all('[data-blocks-engine-capture-gallery-frame]',root).filter(function(node){return node.closest('[data-blocks-engine-capture-gallery]')===root;});}
function set(root,index){var sequence=root.getAttribute('data-blocks-engine-capture-gallery-sequence');if(sequence!==null){var urls=JSON.parse(sequence),size=urls.length;root.setAttribute('data-blocks-engine-capture-gallery-index',String(index));all('[data-blocks-engine-capture-gallery-slot]',root).forEach(function(image){var offset=Number(image.getAttribute('data-blocks-engine-capture-gallery-slot'));image.setAttribute('src',urls[((index+offset)%size+size)%size]);image.removeAttribute('srcset');});return;}var items=frames(root),frame=items[index];if(!frame)return;root.setAttribute('data-blocks-engine-capture-gallery-index',String(index));items.forEach(function(node){node.hidden=node!==frame;node.style.setProperty('display',node===frame?(node.getAttribute('data-blocks-engine-capture-gallery-display')||'block'):'none','important');});var text=JSON.parse(frame.getAttribute('data-blocks-engine-capture-gallery-text')||'[]');text.forEach(function(record){var node=root.querySelector(record.selector);if(node)node.textContent=record.value;});}
function activate(event){var control=event.target.closest&&event.target.closest('[data-blocks-engine-capture-gallery-direction]');if(control){var root=control.closest('[data-blocks-engine-capture-gallery]');if(!root)return;event.preventDefault();event.stopPropagation();var sequence=root.getAttribute('data-blocks-engine-capture-gallery-sequence'),size=sequence!==null?JSON.parse(sequence).length:frames(root).length,index=Number(root.getAttribute('data-blocks-engine-capture-gallery-index'));set(root,(index+Number(control.getAttribute('data-blocks-engine-capture-gallery-direction'))+size)%size);return;}
var stage=event.target.closest&&event.target.closest('[data-blocks-engine-capture-gallery-stage][data-blocks-engine-capture-dialog-trigger]');if(!stage||!event.target.closest('img'))return;var owner=stage.closest('[data-blocks-engine-capture-gallery]'),panel=document.getElementById(stage.getAttribute('aria-controls'));if(!owner||!panel)return;var overlay=panel.querySelector('[data-blocks-engine-capture-gallery]'),items=frames(owner),selected=items[Number(owner.getAttribute('data-blocks-engine-capture-gallery-index'))],identity=selected&&selected.getAttribute('data-blocks-engine-capture-gallery-full-image');var target=overlay&&frames(overlay).findIndex(function(frame){return frame.getAttribute('data-blocks-engine-capture-gallery-image')===identity;});if(overlay&&target>=0)set(overlay,target);}
document.addEventListener('click',activate,true);
})();`;

function wire($: cheerio.CheerioAPI, gallery: CapturedGallery, fullImages: boolean): boolean {
	if (gallery.coverage !== 'complete' || gallery.restoration !== 'verified') return false;
	let wired = false;
	$(gallery.selector).each((_, element) => {
		const root = $(element);
		if (root.is('[data-blocks-engine-capture-gallery]')) return;
		const width = root.attr('data-blocks-engine-capture-gallery-capture-width');
		if (width && Number(width) !== gallery.viewport?.width) return;
		const select = (selector: string) => selector === ':scope' ? root : root.find(selector);
		const stage = select(gallery.stage);
		const next = select(gallery.next), previous = select(gallery.previous);
		if (stage.length !== 1 || next.length !== 1 || previous.length !== 1) return;
		const initial = gallery.initial;
		const frameImages = gallery.frames.map(frame => {
			const parsed = cheerio.load(frame.html, null, false);
			return parsed('img').toArray().map(image => parsed(image).attr('src') || '');
		});
		const frameStructures = gallery.frames.map(frame => {
			const parsed = cheerio.load(frame.html, null, false);
			parsed('img').attr('src', '__DLA_GALLERY_SLOT__');
			return parsed.root().html();
		});
		const slots = stage.find('img').toArray();
		const srcSwap = frameImages.length >= 2 && frameImages.every(images => images.length === slots.length && images.every(Boolean)) && frameStructures.every(structure => structure === frameStructures[0]);
		if (srcSwap && slots.length >= 2) {
			const primary = Math.floor(slots.length / 2);
			const sequence = gallery.frames.map((_, index) => frameImages[(initial + index) % frameImages.length]![primary]!);
			const offsets = frameImages[0]!.map((_, slot) => sequence.findIndex((_, offset) => frameImages.every((images, index) => images[slot] === sequence[(index + offset + initial) % sequence.length])));
			if (new Set(sequence).size === sequence.length && offsets.every(offset => offset >= 0)) {
				root.attr('data-blocks-engine-capture-gallery', '').attr('data-blocks-engine-capture-gallery-source', gallery.selector).attr('data-blocks-engine-capture-gallery-sequence', JSON.stringify(sequence)).attr('data-blocks-engine-capture-gallery-index', '0');
				slots.forEach((image, slot) => { const offset = offsets[slot]!; $(image).attr('data-blocks-engine-capture-gallery-slot', String(offset <= sequence.length / 2 ? offset : offset - sequence.length)); });
				next.attr('data-blocks-engine-capture-gallery-direction', '1'); previous.attr('data-blocks-engine-capture-gallery-direction', '-1');
				wired = true;
				return;
			}
		}
		stage.empty();
		gallery.frames.forEach((frame, index) => {
			const fragment = cheerio.load(frame.html, null, false);
			const child = fragment.root().children().first();
			child
				.attr('data-blocks-engine-capture-gallery-frame', String(index))
				.attr('data-blocks-engine-capture-gallery-image', frame.key)
				.attr('data-blocks-engine-capture-gallery-display', child.css('display')?.replace(/\s*!important\s*$/, '') || 'block')
				.attr('data-blocks-engine-capture-gallery-text', JSON.stringify(frame.text));
			const fullImage = frame.fullImage;
			if (fullImage) child.attr('data-blocks-engine-capture-gallery-full-image', fullImage);
			if (index !== initial) child.attr('hidden', '');
			else child.removeAttr('hidden');
			child.css('display', (index === initial ? child.attr('data-blocks-engine-capture-gallery-display')! : 'none') + ' !important');
			stage.append(fragment.html());
		});
		root.attr('data-blocks-engine-capture-gallery', '').attr('data-blocks-engine-capture-gallery-source', gallery.selector).attr('data-blocks-engine-capture-gallery-index', String(initial));
		for (const record of gallery.frames[initial]!.text) root.find(record.selector.replace(':scope', '')).text(record.value);
		stage.attr('data-blocks-engine-capture-gallery-stage', '').attr('data-blocks-engine-capture-gallery-initial', String(initial));
		next.attr('data-blocks-engine-capture-gallery-direction', '1');
		previous.attr('data-blocks-engine-capture-gallery-direction', '-1');
		if (fullImages) root.find('[aria-label*="Close" i]').attr('data-blocks-engine-capture-gallery-close', '');
		wired = true;
	});
	return wired;
}

export function wireCapturedGalleries(html: string, states: CapturedDialogInteraction[]): string {
	const captured = states.filter(
		state => state.kind === 'gallery' && state.gallery?.inline.coverage === 'complete' && state.gallery.inline.restoration === 'verified'
	);
	if (captured.length === 0) return html;
	const $ = cheerio.load(html);
	let wired = $('[data-blocks-engine-capture-gallery]').length > 0;
	for (const state of captured) wired = wire($, state.gallery!.inline, false) || wired;
	if (wired) {
		$('style[data-blocks-engine-capture-gallery-visibility]').remove();
		$('head').append(
			'<style data-blocks-engine-capture-gallery-visibility>[data-blocks-engine-capture-gallery-frame][hidden]{display:none!important}[data-blocks-engine-capture-gallery-frame]:not([hidden]){display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important}[data-blocks-engine-capture-gallery-direction],[data-blocks-engine-capture-gallery-close]{pointer-events:auto!important}</style>',
		);
		$('script[data-blocks-engine-capture-gallery-runtime]').remove();
		$('head').append(`<script data-blocks-engine-capture-gallery-runtime>${RUNTIME}</script>`);
	}
	return wired ? $.html() : html;
}

export function wireGalleryDialog(html: string, gallery: CapturedGallery, panelId: string): string {
	const $ = cheerio.load(html, null, false);
	wire($, gallery, true);
	$('[data-blocks-engine-capture-gallery-close]').attr('data-blocks-engine-capture-dialog-close', panelId);
	return $.html();
}
