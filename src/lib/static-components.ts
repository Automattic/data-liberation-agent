import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type { CapturedComponent } from './screenshot/component-states.js';
import { applyWidthClasses } from './screenshot/initial-document.js';

function safeStateHtml(html: string): string {
	const $ = cheerio.load(html);
	$('script,iframe,object,embed,base').remove();
	$<Element, string>('*').each((_index, node) => {
		// Captured states come from the live DOM, before initial-document projection.
		applyWidthClasses($(node));
		for (const [name, value] of Object.entries($(node).attr() ?? {})) {
			if (/^on/i.test(name) || name === 'srcdoc' || /^(?:href|src|action|formaction)$/i.test(name) && /^\s*(?:javascript|vbscript|data:text\/html):/i.test(value)) $(node).removeAttr(name);
		}
	});
	return $.html();
}

/** Materialize only classified states; unknown surfaces never become hidden panels. */
export function wireCapturedComponents(html: string, components: CapturedComponent[] = []): string {
	const $ = cheerio.load(html);
	let wired = false;
	let collections = false;
	const carousels: Array<{ selector: string; initial: string; states: Record<string, string>; transitions: CapturedComponent['transitions'] }> = [];
	const disclosures: Array<{ trigger: string; panel: string; initial: string; states: Record<string, { trigger: string; panel: string }>; transitions: CapturedComponent['transitions'] }> = [];
	for (const component of components) {
		if (component.kind === 'collection' && component.collection) {
			const root = $(component.selector).first();
			if (!root.length) continue;
			root.empty();
			for (const member of component.collection.members) {
				const parsed = cheerio.load(safeStateHtml(member.html));
				const item = parsed('body').children().first();
				item.removeAttr('hidden');
				root.append(item.toString());
			}
			for (const selector of component.collection.controls) $(selector).attr('data-blocks-engine-capture-unsupported', 'collection').attr('aria-disabled', 'true').attr('disabled', '');
			collections = true;
		}
		if (component.kind === 'carousel' && component.status === 'captured' && !component.states.some(state => state.evidence?.gallery)) {
			carousels.push({ selector: component.selector, initial: component.initial, states: Object.fromEntries(component.states.map(state => [state.id, safeStateHtml(state.html)])), transitions: component.transitions });
		}
		if (component.kind === 'disclosure' && component.status === 'captured') {
			const trigger = $(component.selector).first();
			const panelId = trigger.attr('aria-controls');
			if (!panelId || trigger.is('details')) continue;
			const states: Record<string, { trigger: string; panel: string }> = {};
			for (const state of component.states) {
				const parsed = cheerio.load(safeStateHtml(state.html));
				const panel = parsed('[id]').filter((_i, node) => parsed(node).attr('id') === panelId).first();
				const control = parsed('[aria-controls]').filter((_i, node) => parsed(node).attr('aria-controls') === panelId).first();
				if (panel.length && control.length) states[state.id] = { trigger: control.toString(), panel: panel.toString() };
			}
			if (states.open && states.closed) {
				trigger.attr('data-blocks-engine-capture-component-disclosure', String(disclosures.length));
				disclosures.push({ trigger: component.selector, panel: panelId, initial: component.initial, states, transitions: component.transitions });
			}
		}

		if (component.status !== 'captured' || component.kind !== 'tabs') continue;
		const root = $(component.selector).first();
		if (!root.length) continue;
		const tabs = root.find('[role="tab"]');
		// A bound sibling region becomes the initial panel; observed panels follow it.
		let anchor = root;
		if (component.panel) {
			const region = $(component.panel).first();
			const panels = component.states.map(state => ({ state, panel: cheerio.load(safeStateHtml(state.html))('[role="tabpanel"]').first() }));
			const initial = panels.find(({ state }) => state.id === component.initial)?.panel;
			if (!region.length || !initial?.attr('id') || region.is(root.parents())) continue;
			for (const { state, panel } of panels) if (panel.attr('id')) tabs.eq(Number(state.id.slice(4))).attr('aria-controls', panel.attr('id')!);
			region.replaceWith(initial.toString());
			anchor = $('[id]').filter((_i, node) => $(node).attr('id') === initial.attr('id')).first();
		}
		for (const state of component.states) {
			if (state.id === component.initial) continue;
			const tab = tabs.eq(Number(state.id.slice(4)));
			const id = tab.attr('aria-controls');
			if (!id || $('[id]').toArray().some(node => $(node).attr('id') === id)) continue;
			const panel = cheerio.load(safeStateHtml(state.html))('[role="tabpanel"]').first();
			if (panel.attr('id') !== id) continue;
			panel.attr('hidden', '');
			anchor.after(panel.toString());
			if (component.panel) anchor = anchor.next();
		}
		root.attr('data-blocks-engine-capture-tabs', '');
		wired = true;
	}
	if (carousels.length) {
		const config = JSON.stringify(carousels).replace(/</g, '\\u003c');
		$('head').append(`<script data-blocks-engine-capture-component-carousel-runtime>(function(){var configs=${config};configs.forEach(function(config){config.current=config.initial;});document.addEventListener('click',function(event){configs.forEach(function(config){var edge=config.transitions.find(function(edge){return edge.from===config.current&&event.target.closest(edge.trigger.selector);});if(!edge)return;var root=document.querySelector(config.selector),holder=document.createElement('div');holder.innerHTML=config.states[edge.to];var replacement=holder.querySelector('body')||holder;var next=replacement.querySelector(config.selector);if(root&&next){root.replaceWith(next);config.current=edge.to;}});});})();</script>`);
	}
	if (disclosures.length) {
		const config = JSON.stringify(disclosures).replace(/</g, '\\u003c');
		$('head').append(`<script data-blocks-engine-capture-component-disclosure-runtime>(function(){
var configs=${config};
configs.forEach(function(config){config.current=config.initial;});
document.addEventListener('click',function(event){
	if(!(event.target instanceof Element))return;
	configs.forEach(function(config,key){
		var trigger=document.querySelector('[data-blocks-engine-capture-component-disclosure="'+key+'"]');
		if(!trigger)return;
		var next;
		if(trigger.contains(event.target)){
			next=trigger.getAttribute('aria-expanded')==='true'?'closed':'open';
		}else{
			var edge=config.transitions.find(function(edge){
				return edge.from===config.current&&edge.trigger.action==='click'&&event.target.closest(edge.trigger.selector);
			});
			if(!edge)return;
			next=edge.to;
		}
		var state=config.states[next];
		if(!state)return;
		var holder=document.createElement('div');
		holder.innerHTML=state.trigger;
		var observed=holder.firstElementChild;
		Array.from(observed.attributes).forEach(function(attr){
			if(attr.name!=='id'&&!/^on/i.test(attr.name))trigger.setAttribute(attr.name,attr.value);
		});
		var panel=document.getElementById(config.panel);
		if(panel)panel.outerHTML=state.panel;else trigger.insertAdjacentHTML('afterend',state.panel);
		config.current=next;
	});
});
})();</script>`);
	}
	if (wired) $('head').append(`<script data-blocks-engine-capture-component-runtime>(function(){function ready(){document.querySelectorAll('[data-blocks-engine-capture-tabs]').forEach(function(root){var tabs=Array.from(root.querySelectorAll('[role="tab"]'));tabs.forEach(function(tab){tab.addEventListener('click',function(){tabs.forEach(function(other){var selected=other===tab;other.setAttribute('aria-selected',String(selected));other.tabIndex=selected?0:-1;var panel=document.getElementById(other.getAttribute('aria-controls'));if(panel)panel.hidden=!selected;});});});});}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();})();</script>`);
	return wired || collections || disclosures.length || carousels.length ? $.html() : html;
}
