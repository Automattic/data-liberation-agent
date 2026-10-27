import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DROPDOWN_ANCESTOR_ATTRIBUTE_PATTERN, type CapturedDropdownAncestorState } from './screenshot/dropdown-ancestor-state.js';
import { wireCapturedCollections } from './static-collections.js';
import { wireCapturedGalleries, wireGalleryDialog } from './static-galleries.js';
import type {
	CapturedDialogInteraction,
	CapturedInitialDialog,
	CapturedRouteNavigation,
} from './screenshot/interaction-capture.js';

// Base summary styling must lose to every author rule on the summary or
// details — e.g. a responsive `md:hidden` hamburger, or the `display:flex` a
// converted button had. Zero specificity (`:where(...)`) is not enough on its
// own: unlayered CSS beats every cascade layer, so Substack's
// `@layer legacy{.post-ufi .post-ufi-button{display:flex}}` lost to an
// unlayered `:where()` rule and the trigger wrapped onto two lines. The base
// rules therefore live in their own layer, declared first in <head> so it is
// the lowest-priority layer too (see wireCapturedDialogs).
const DISCLOSURE_BASE_CSS =
	'@layer data-blocks-engine-capture-disclosure-base{' +
	':where(details.data-blocks-engine-capture-disclosure>summary){list-style:none;cursor:pointer;display:inline-block}' +
	':where(details.data-blocks-engine-capture-disclosure>summary)::-webkit-details-marker{display:none}' +
	'}';
// State-driven dialog rules stay unlayered and keep their specificity so
// open/closed behavior cannot be overridden. Triggered dialogs keep the
// authored control and only position the sibling panel. Initial dialogs stay
// native details because they are not a layout child of the source page.
const DISCLOSURE_CSS =
	'details.data-blocks-engine-capture-disclosure[hidden]{display:none!important}' +
	'details.data-blocks-engine-capture-disclosure:not([open])>.data-blocks-engine-capture-dialog{display:none!important}' +
	'details.data-blocks-engine-capture-disclosure:not(.data-blocks-engine-capture-dropdown)[open]>.data-blocks-engine-capture-dialog{display:block;position:fixed;inset:0;z-index:2147483646;overflow:auto;background:#fff}' +
	'details.data-blocks-engine-capture-disclosure.data-blocks-engine-capture-dropdown{position:static}' +
	'details.data-blocks-engine-capture-disclosure.data-blocks-engine-capture-dropdown[open]>.data-blocks-engine-capture-dialog{display:block;position:absolute;top:100%;left:0;right:0;z-index:2147483646}' +
	'details.data-blocks-engine-capture-disclosure[open]>.data-blocks-engine-capture-dialog>:first-child{display:block!important;visibility:visible!important;opacity:1!important}' +
	'details.data-blocks-engine-capture-initial-dialog>summary{position:fixed;z-index:2147483647;right:1rem;top:1rem}' +
	'details.data-blocks-engine-capture-initial-dialog:not([open])>summary{display:none!important}' +
	'[data-blocks-engine-capture-dialog-panel][hidden]:not([data-blocks-engine-capture-resting-panel]),[data-blocks-engine-capture-dialog-close][hidden]{display:none!important}' +
	'[data-blocks-engine-capture-dialog-panel]:not(.data-blocks-engine-capture-dropdown):not([data-blocks-engine-capture-resting-panel]):not([hidden]){display:block;position:fixed;inset:0;z-index:2147483646;overflow:auto;background:#fff}' +
	'[data-blocks-engine-capture-dialog-panel].data-blocks-engine-capture-dropdown:not([data-blocks-engine-capture-existing-panel]):not([data-blocks-engine-capture-observed-placement]):not([hidden]){display:block;position:absolute;top:100%;left:0;right:0;z-index:2147483646}' +
	'[data-blocks-engine-capture-dialog-panel]:not([data-blocks-engine-capture-resting-panel]):not([data-blocks-engine-capture-observed-placement]):not([hidden])>:first-child{display:block!important;visibility:visible!important;opacity:1!important}' +
	'[data-blocks-engine-capture-dialog-close]:not([hidden]){position:fixed;z-index:2147483647;right:1rem;top:1rem;padding:.5rem .75rem;background:#fff;color:#111;border:1px solid currentColor;border-radius:.25rem}';

const DISCLOSURE_RUNTIME = `(function(){
function triggers(){return document.querySelectorAll('[data-blocks-engine-capture-dialog-trigger]');}
function panel(trigger){var id=trigger.getAttribute('aria-controls');return id?document.getElementById(id):null;}
function closeFor(trigger){var id=trigger.getAttribute('aria-controls');return id?document.querySelector('[data-blocks-engine-capture-dialog-close="'+id+'"]'):null;}
function concealed(trigger){var style=getComputedStyle(trigger);if(style.display==='none'||style.visibility==='hidden')return true;var rect=trigger.getBoundingClientRect();return rect.width===0||rect.height===0;}
function ancestorBindings(trigger){try{return JSON.parse(trigger.getAttribute('data-blocks-engine-capture-dialog-ancestor-state')||'[]');}catch(error){return [];}}
function classTokens(value){return (value||'').split(/\\s+/).filter(Boolean);}
function ancestorAt(trigger,depth){var node=trigger;while(depth--&&node)node=node.parentElement;return node;}
function applyAncestors(trigger,open){ancestorBindings(trigger).forEach(function(binding){var node=ancestorAt(trigger,binding.depth);if(!node)return;
  Object.keys(binding.closed).forEach(function(name){var value=open?binding.opened[name]:binding.closed[name];
    if(!open){var owner=Array.prototype.find.call(triggers(),function(other){return other!==trigger&&!concealed(other)&&other.getAttribute('aria-expanded')==='true'&&ancestorBindings(other).some(function(row){return ancestorAt(other,row.depth)===node&&Object.prototype.hasOwnProperty.call(row.opened,name);});});if(owner){var row=ancestorBindings(owner).find(function(row){return ancestorAt(owner,row.depth)===node&&Object.prototype.hasOwnProperty.call(row.opened,name);});value=row.opened[name];}}
    if(name==='class'){var target=classTokens(value);classTokens(open?binding.closed[name]:binding.opened[name]).forEach(function(token){if(target.indexOf(token)<0)node.classList.remove(token);});target.forEach(function(token){node.classList.add(token);});if(value===null&&!node.classList.length)node.removeAttribute(name);return;}
    if(value===null)node.removeAttribute(name);else node.setAttribute(name,value);
  });
});}
function apply(trigger){
  var target=panel(trigger);if(!target)return;
  var inactive=concealed(trigger),open=trigger.getAttribute('aria-expanded')==='true'&&!inactive;
  applyAncestors(trigger,open);
  if(!open&&Array.prototype.some.call(triggers(),function(other){return other!==trigger&&panel(other)===target&&!concealed(other)&&other.getAttribute('aria-expanded')==='true';}))return;
  var captured=trigger.getAttribute('data-blocks-engine-capture-dialog-panel-state');
  var opened=captured?JSON.parse(captured):null;
  if(open&&opened&&target.__dlaDialogState!==captured){target.innerHTML=opened.html;target.__dlaDialogState=captured;}
  var existing=target.getAttribute('data-blocks-engine-capture-existing-panel');
  if(existing){
    var states=JSON.parse(existing),state=inactive?states.resting:(opened||states.opened);
    ['style','class'].forEach(function(name){if(state[name]===null)target.removeAttribute(name);else target.setAttribute(name,state[name]);});
    target.toggleAttribute('data-blocks-engine-capture-resting-panel',inactive);
    target.hidden=inactive?states.resting.hidden:!open;
    if(inactive&&!target.classList.contains('data-blocks-engine-capture-dropdown')){
      // Observe authored resting CSS, not the generated modal positioning.
      // A concealed control only exposes a panel that is visible in normal flow.
      var style=getComputedStyle(target),rect=target.getBoundingClientRect();
      var inline=style.display!=='none'&&style.visibility!=='hidden'&&style.position!=='fixed'&&style.position!=='absolute'&&rect.width>0&&rect.height>0;
      target.toggleAttribute('data-blocks-engine-capture-resting-panel',inline);
      if(!inline)target.hidden=true;
    }
  }else target.hidden=!open;
  var close=closeFor(trigger);if(close)close.hidden=!open;
}
function set(trigger,open){if(open&&concealed(trigger))open=false;if(open)triggers().forEach(function(other){if(other!==trigger&&panel(other)===panel(trigger)&&other.getAttribute('aria-expanded')==='true')set(other,false);});trigger.setAttribute('aria-expanded',open?'true':'false');var label=trigger.getAttribute('data-blocks-engine-capture-disclosure-label');if(label)trigger.setAttribute('aria-label',open?'Close '+label:label);apply(trigger);}
function toggle(trigger){set(trigger,trigger.getAttribute('aria-expanded')!=='true');}
function onClick(event){var close=event.target.closest&&event.target.closest('[data-blocks-engine-capture-dialog-close]');if(close){event.preventDefault();var id=close.getAttribute('data-blocks-engine-capture-dialog-close');var owner=id&&document.querySelector('[data-blocks-engine-capture-dialog-trigger][aria-controls="'+id+'"]');if(owner){set(owner,false);owner.focus();}return;}var trigger=event.target.closest&&event.target.closest('[data-blocks-engine-capture-dialog-trigger]');if(!trigger||!panel(trigger))return;var nested=event.target.closest('a,button');if(nested&&nested!==trigger)return;event.preventDefault();var was=trigger.getAttribute('aria-expanded')==='true';toggle(trigger);if(was)trigger.focus();}
function onKey(event){if(event.key==='Escape'){var open=Array.prototype.slice.call(triggers()).filter(function(item){var target=panel(item);return !concealed(item)&&item.getAttribute('aria-expanded')==='true'&&target&&!target.hidden;}).pop();if(open){event.preventDefault();set(open,false);open.focus();return;}var details=Array.prototype.slice.call(document.querySelectorAll('details.data-blocks-engine-capture-initial-dialog[open]')).pop();if(!details)return;event.preventDefault();details.open=false;var summary=details.querySelector(':scope > summary');if(summary)summary.focus();return;}if(event.key!=='Enter'&&event.key!==' ')return;var trigger=event.target.closest&&event.target.closest('[data-blocks-engine-capture-dialog-trigger]');if(!trigger||!panel(trigger))return;if(trigger.tagName==='BUTTON'||(trigger.tagName==='A'&&event.key==='Enter'))return;event.preventDefault();toggle(trigger);}
function ready(){document.addEventListener('click',onClick);document.addEventListener('keydown',onKey);window.addEventListener('resize',function(){triggers().forEach(apply);});triggers().forEach(apply);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();`;
const LISTBOX_RUNTIME = `(function(){function all(selector,root){return Array.prototype.slice.call((root||document).querySelectorAll(selector));}function panel(trigger){var key=trigger.getAttribute('data-blocks-engine-capture-listbox-trigger');return key===null?null:document.querySelector('[data-blocks-engine-capture-listbox-panel="'+key+'"]');}function options(surface){return surface?all('[role="option"]',surface):[];}function close(trigger){var surface=panel(trigger);if(!surface)return;surface.hidden=true;trigger.setAttribute('aria-expanded','false');}function open(trigger){var surface=panel(trigger);if(!surface)return;surface.hidden=false;trigger.setAttribute('aria-expanded','true');}function select(trigger,option){var surface=panel(trigger);if(!surface)return;options(surface).forEach(function(item){item.setAttribute('aria-selected',item===option?'true':'false');});var label=option.getAttribute('aria-label')||option.textContent||'';trigger.textContent=label.trim();if(option.id)trigger.setAttribute('aria-activedescendant',option.id);close(trigger);trigger.focus();}function move(trigger,option,delta){var surface=panel(trigger),items=options(surface);if(!surface||!items.length)return;var index=items.indexOf(option);var next=items[Math.max(0,Math.min(items.length-1,index+delta))]||items[0];items.forEach(function(item){item.tabIndex=item===next?0:-1;});next.focus();}function ready(){all('[data-blocks-engine-capture-listbox-trigger]').forEach(function(trigger){var surface=panel(trigger);if(!surface)return;trigger.setAttribute('type','button');options(surface).forEach(function(option){option.tabIndex=-1;option.addEventListener('click',function(){select(trigger,option);});option.addEventListener('keydown',function(event){if(event.key==='Escape'){event.preventDefault();close(trigger);trigger.focus();}else if(event.key==='ArrowDown'){event.preventDefault();move(trigger,option,1);}else if(event.key==='ArrowUp'){event.preventDefault();move(trigger,option,-1);}else if(event.key==='Enter'||event.key===' '){event.preventDefault();select(trigger,option);}});});trigger.addEventListener('click',function(){if(trigger.getAttribute('aria-expanded')==='true')close(trigger);else open(trigger);});trigger.addEventListener('keydown',function(event){if(event.key==='Escape'){if(trigger.getAttribute('aria-expanded')==='true'){event.preventDefault();close(trigger);}return;}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open(trigger);move(trigger,options(panel(trigger))[0],event.key==='ArrowDown'?1:-1);}else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(trigger.getAttribute('aria-expanded')!=='true')open(trigger);}});});}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();})();`;

const CHOICE_GROUP_RUNTIME = `(function(){var configs=__DLA_CHOICE_CONFIG__;function configFor(group){return configs[group.getAttribute('data-blocks-engine-capture-choice-group')]||null;}function replay(group,index){var config=configFor(group),html=config&&config.transitions[String(index)];if(!html)return;var holder=document.createElement('div');holder.innerHTML=html;var replacement=holder.firstElementChild;if(!replacement)return;var key=group.getAttribute('data-blocks-engine-capture-choice-group');replacement.setAttribute('data-blocks-engine-capture-choice-group',key);group.replaceWith(replacement);var next=replacement.querySelector('[data-blocks-engine-capture-choice-index="'+index+'"]');if(next&&typeof next.focus==='function')next.focus();}function activate(event){var target=event.target;if(!(target instanceof Element))return;var choice=target.closest('[data-blocks-engine-capture-choice-index]');var group=choice&&choice.closest('[data-blocks-engine-capture-choice-group]');if(!choice||!group)return;var index=choice.getAttribute('data-blocks-engine-capture-choice-index');if(index===null)return;if(event.type==='keydown'){if(event.key!=='Enter'&&event.key!==' ')return;event.preventDefault();}replay(group,index);}function ready(){document.addEventListener('click',activate);document.addEventListener('keydown',activate);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();})();`;

// Delegated activation survives collection replacement and keeps answer content
// in the authoring tree. The source probe marks single-open groups explicitly.
const LOCAL_DISCLOSURE_RUNTIME = `(function(){
function panelFor(trigger){
  var id=trigger.getAttribute('aria-controls');
  for(var scope=trigger.parentElement;scope;scope=scope===document.body?null:scope.parentElement){var panel=Array.prototype.find.call(scope.querySelectorAll('[data-blocks-engine-capture-local-disclosure]'),function(panel){return panel.id===id;});if(panel)return panel;}
  return null;
}
function set(trigger,open){var panel=panelFor(trigger);if(!panel)return;panel.hidden=!open;if(panel.hasAttribute('aria-hidden'))panel.setAttribute('aria-hidden',String(!open));panel.toggleAttribute('inert',!open);trigger.setAttribute('aria-expanded',String(open));trigger.querySelectorAll('[data-blocks-engine-capture-disclosure-open-class],[data-blocks-engine-capture-disclosure-open-style]').forEach(function(icon){['class','style'].forEach(function(name){var value=icon.getAttribute('data-blocks-engine-capture-disclosure-'+(open?'open':'closed')+'-'+name);if(value!==null)icon.setAttribute(name,value);});});}
function activate(event){
  var trigger=event.target.closest&&event.target.closest('[aria-controls]');
  if(!trigger||!panelFor(trigger))return;
  if(event.type==='keydown'){if(trigger.tagName==='BUTTON'||(event.key!=='Enter'&&event.key!==' '))return;event.preventDefault();}
  var open=trigger.getAttribute('aria-expanded')!=='true',group=trigger.closest('[data-blocks-engine-capture-exclusive-disclosures]');
  if(open&&group)group.querySelectorAll('[aria-controls][aria-expanded="true"]').forEach(function(other){set(other,false);});
  set(trigger,open);
}
document.addEventListener('click',activate);document.addEventListener('keydown',activate);
})();`;

/** A captured choice-group state the export can replay without a source runtime. */
export function isReplayableChoiceGroup( state: CapturedDialogInteraction ): boolean {
	return (
		state.status === 'captured' &&
		state.kind === 'choice-group' &&
		Boolean( state.choiceGroup ) &&
		state.choiceGroup!.replay === 'activation-determined' &&
		state.choiceGroup!.restoration === 'verified' &&
		state.choiceGroup!.coverage === 'complete' &&
		! state.choiceGroup!.transition.htmlTruncated
	);
}

/** Finding code for an observed interaction the export cannot reproduce. */
export const INTERACTION_UNREPLAYABLE_CODE = 'interaction_unreplayable';

/**
 * One visible loss per observed choice group that `wireCapturedDialogs` will
 * not replay (#901). Without it the group's static markup ships silently and
 * the reader's interaction disappears with no record.
 */
export function choiceGroupInteractionLosses(
	states: readonly CapturedDialogInteraction[]
): Array< { code: typeof INTERACTION_UNREPLAYABLE_CODE; reason: string; severity: 'warning' } > {
	const groups = new Map< string, CapturedDialogInteraction[] >();
	for ( const state of states ) {
		if ( state.status !== 'captured' || state.kind !== 'choice-group' || ! state.choiceGroup ) continue;
		const key = `${ state.choiceGroup.group.selector }|${ state.choiceGroup.group.id ?? '' }`;
		groups.set( key, [ ...( groups.get( key ) ?? [] ), state ] );
	}
	const losses: Array< { code: typeof INTERACTION_UNREPLAYABLE_CODE; reason: string; severity: 'warning' } > = [];
	for ( const members of groups.values() ) {
		if ( members.every( isReplayableChoiceGroup ) ) continue;
		const group = members[ 0 ]!.choiceGroup!;
		const why =
			members.map( ( state ) => state.choiceGroup!.replayReason ).find( Boolean ) ??
			( group.replay === 'unsupported' ? 'replay unsupported'
				: group.restoration !== 'verified' ? 'source restoration unverified'
				: group.coverage !== 'complete' ? 'partial coverage'
				: 'transition truncated' );
		losses.push( {
			code: INTERACTION_UNREPLAYABLE_CODE,
			reason: `choice group ${ group.group.selector } (${ group.choices.length } choices) ships as static markup: ${ why }`,
			severity: 'warning',
		} );
	}
	return losses;
}

export function wireCapturedDialogs(
	html: string,
	states: CapturedDialogInteraction[],
	initialDialogs: CapturedInitialDialog[] = []
): string {
	html = wireCapturedCollections( html, states );
	html = wireCapturedGalleries( html, states );
	// Disclosure/accordion panels (`kind === 'disclosure'`) are restored in
	// place, in the live DOM, before the page's HTML is ever serialized (see
	// `hydrateDisclosureContent`) — their content is already inline in `html`
	// here. Selectable-set states (`kind === 'selectable-set'`) are evidence of
	// a shared region. Choice-group states are the exception: their own group
	// markup is the observed transition and can be replayed without a source
	// runtime. Neither shape is a popup, so only dialog/menu-kind states are
	// wired as disclosures.
	const captured = states.filter(
		( state ) =>
			state.status === 'captured' &&
			state.dialog?.html &&
			( state.kind === undefined || state.kind === 'dialog' || (
				state.kind === 'gallery' && state.gallery?.lightbox?.coverage === 'complete' &&
				state.gallery.closed && ! state.dialog.htmlTruncated
			) )
	);
	const choiceStates = states.filter( isReplayableChoiceGroup );
	const localDisclosures = html.includes('data-blocks-engine-capture-local-disclosure');
	if ( captured.length === 0 && choiceStates.length === 0 && initialDialogs.length === 0 && !localDisclosures ) return html;
	const $ = cheerio.load( html );
	let wired = 0;
	let listboxes = 0;
	const reusedPanels = new Map< string, string >();
	const choiceConfigs: Array< { transitions: Record< string, string > } > = [];
	const choiceGroups = new Map< string, NonNullable< CapturedDialogInteraction[ 'choiceGroup' ] >[] >();
	for ( const state of choiceStates ) {
		const group = state.choiceGroup!;
		const key = `${ group.group.selector }|${ group.group.id ?? '' }`;
		const existing = choiceGroups.get( key ) ?? [];
		existing.push( group );
		choiceGroups.set( key, existing );
	}
	for ( const groups of choiceGroups.values() ) {
		const descriptor = groups[ 0 ]!;
		const key = String( choiceConfigs.length );
		const transitions: Record< string, string > = {};
		for ( const group of groups ) transitions[ String( group.transition.selectedIndex ) ] = group.transition.html;
		const roots = selectByCapturedSelector( $, descriptor.group.selector, descriptor.group.tag );
		roots.each( ( _, element ) => {
			const root = $( element );
			root.attr( 'data-blocks-engine-capture-choice-group', key );
			const choices = descriptor.choices;
			const candidates = root
				.find( choices[ 0 ]?.tag || '*' )
				.filter( ( __, candidate ) => ( $( candidate ).attr( 'role' ) || '' ) === ( choices[ 0 ]?.role || '' ) )
				.toArray();
			candidates.slice( 0, choices.length ).forEach( ( candidate, index ) =>
				$( candidate ).attr( 'data-blocks-engine-capture-choice-index', String( index ) )
			);
		} );
		if ( roots.length > 0 && Object.keys( transitions ).length > 0 ) choiceConfigs.push( { transitions } );
	}
	// Resolve every trigger against the same pre-mutation tree. Inserting a
	// panel and its close button can shift positional selectors used by later
	// states in the same chrome landmark.
	const capturedTriggers = captured.map( state => findTriggers( $, state.trigger ) );
	for ( const [ index, state ] of captured.entries() ) {
		const sharedPanelId = reusedPanels.get( state.dialog!.selector );
		const existingPanel = selectByCapturedSelector( $, state.dialog?.selector, state.dialog?.tag )
			.not( '[data-blocks-engine-capture-dialog-panel], [data-blocks-engine-capture-dialog-panel] *' );
		const reusePanel = ( state.dialog?.presentation === 'dropdown' || state.dialog?.restingInline === true ) && existingPanel.length === 1;
		if ( !reusePanel && !sharedPanelId ) removeCapturedDialog( $, state.dialog?.selector );
		// An earlier exported panel contains a captured snapshot, not another
		// instance of the observed source control whose ID it happens to copy.
		const triggers = capturedTriggers[ index ]!
			.not( '[data-blocks-engine-capture-dialog-panel], [data-blocks-engine-capture-dialog-panel] *' );
		triggers.each( ( _, element ) => {
			const trigger = $( element );
			if (state.gallery) {
				const width = trigger.closest('[data-blocks-engine-capture-gallery-capture-width]').attr('data-blocks-engine-capture-gallery-capture-width');
				if (width && Number(width) !== state.gallery.inline.viewport.width) return;
				const existing = trigger.attr('aria-controls');
				if (trigger.attr('data-blocks-engine-capture-dialog-trigger') && existing) {
					const surface = gallerySurface($, trigger), panel = $('#' + cssEscape(existing));
					const key = trigger.attr('data-blocks-engine-capture-dialog-trigger');
					surface.find('[data-blocks-engine-capture-dialog-close]').filter((_, close) => $(close).attr('data-blocks-engine-capture-dialog-close') === key && !$(close).closest('[data-blocks-engine-capture-dialog-panel]').length).remove();
					panel.attr('data-blocks-engine-capture-dialog-panel', existing);
					panel.find('[data-blocks-engine-capture-dialog-close]').attr('data-blocks-engine-capture-dialog-close', existing);
					trigger.attr('data-blocks-engine-capture-dialog-trigger', existing);
					surface.append(panel);
					return;
				}
			}
			if (
				trigger.closest( 'details.data-blocks-engine-capture-disclosure' ).length ||
				trigger.attr( 'data-blocks-engine-capture-listbox-trigger' ) ||
				trigger.attr( 'data-blocks-engine-capture-dialog-trigger' )
			) return;
			if ( state.dialog?.role?.toLowerCase() === 'listbox' || state.trigger.ariaHaspopup.toLowerCase() === 'listbox' ) {
				const key = String( listboxes++ );
				const panel = $( '<div hidden></div>' );
				panel.attr( 'data-blocks-engine-capture-listbox-panel', key ).html( state.dialog!.html );
				trigger.attr( 'data-blocks-engine-capture-listbox-trigger', key ).attr( 'type', 'button' ).after( panel );
				trigger.attr( 'aria-expanded', 'false' );
				return;
			}
			const label = trigger.attr( 'aria-label' ) || normalizedText( trigger.text() );
			const dropdown = state.dialog?.presentation === 'dropdown';
			const observed = resolveObservedAncestors( $, trigger, state.dialog?.ancestorState, dropdown );
			if ( state.dialog?.ancestorState && !observed ) trigger.attr( 'data-blocks-engine-capture-dialog-ancestor-unverified', state.dialog.ancestorState.reason ?? 'portable-owner-mismatch' );
			if ( observed ) trigger.attr( 'data-blocks-engine-capture-dialog-ancestor-state', JSON.stringify( observed.state.ancestors ) );
			const reusedPanelId = reusedPanels.get( state.dialog!.selector );
			// A source can reuse one responsive panel root for different trigger contents.
			// Retain its single DOM identity while replaying each observed state,
			// rather than binding every trigger to the first captured contents.
			if ( reusePanel || reusedPanelId ) {
				const snapshot = $( state.dialog!.html ).first();
				trigger.attr( 'data-blocks-engine-capture-dialog-panel-state', JSON.stringify( {
					html: snapshot.html() ?? '',
					style: ( snapshot.attr( 'style' ) ?? '' ).replace( /(display\s*:[^;!]+)\s*!important/gi, '$1' ),
					class: `${ snapshot.attr( 'class' ) ?? '' }${ dropdown ? ' data-blocks-engine-capture-dropdown' : '' }`.trim(),
				} ) );
			}
			if ( reusedPanelId ) {
				trigger.attr( 'data-blocks-engine-capture-dialog-trigger', reusedPanelId ).attr( 'aria-controls', reusedPanelId ).attr( 'aria-expanded', 'false' );
				if ( label ) trigger.attr( 'data-blocks-engine-capture-disclosure-label', label );
				if ( !trigger.attr( 'aria-haspopup' ) ) trigger.attr( 'aria-haspopup', dropdown ? 'menu' : 'dialog' );
				return;
			}
			const panelId = reusePanel && state.dialog?.id ? state.dialog.id : nextDialogId( $ );
			const sourcePlaced = Boolean( observed?.parent );
			// Modality follows the observed source presentation: a dropdown leaves
			// the page interactive, so it does not claim aria-modal.
			const panel = reusePanel || sourcePlaced ? $( state.dialog!.html ).first() : $( `<div class="data-blocks-engine-capture-dialog" role="dialog"${ dropdown ? '' : ' aria-modal="true"' } hidden></div>` );
			if ( sourcePlaced ) panel.addClass( 'data-blocks-engine-capture-dialog' );
			if ( reusePanel || sourcePlaced ) {
				// Snapshot display overrides the source's closed-state rule, but must
				// still yield to our hidden-state rule on the same (reused) root.
				panel.attr( 'style', ( panel.attr( 'style' ) ?? '' ).replace( /(display\s*:[^;!]+)\s*!important/gi, '$1' ) );
				// A shared responsive document can show this same panel without its
				// phone toggle. In that state, authored CSS and inline styles own it.
				if ( reusePanel ) panel.attr( 'data-blocks-engine-capture-existing-panel', JSON.stringify( {
					resting: {
						style: existingPanel.attr( 'style' ) ?? null,
						class: `${ existingPanel.attr( 'class' ) ?? '' }${ dropdown ? ' data-blocks-engine-capture-dropdown' : '' }`.trim(),
						hidden: existingPanel.attr( 'hidden' ) !== undefined,
					},
					opened: {
						style: panel.attr( 'style' ) ?? null,
						class: `${ panel.attr( 'class' ) ?? '' }${ dropdown ? ' data-blocks-engine-capture-dropdown' : '' }`.trim(),
					},
				} ) ).attr( 'hidden', '' );
				if ( sourcePlaced ) panel.attr( 'data-blocks-engine-capture-observed-placement', 'true' ).attr( 'hidden', '' );
			}
			panel.attr( 'id', panelId ).attr( 'data-blocks-engine-capture-dialog-panel', panelId );
			if ( dropdown ) panel.addClass( 'data-blocks-engine-capture-dropdown' );
			if ( state.dialog?.ariaLabel ) panel.attr( 'aria-label', state.dialog.ariaLabel );
			if ( !reusePanel && !sourcePlaced ) panel.html( state.gallery?.lightbox
				? wireGalleryDialog( state.dialog!.html, state.gallery.lightbox, panelId )
				: state.dialog!.html );
			if ( label ) trigger.attr( 'data-blocks-engine-capture-disclosure-label', label );
			trigger.attr( 'data-blocks-engine-capture-dialog-trigger', panelId );
			trigger.attr( 'aria-controls', panelId );
			trigger.attr( 'aria-expanded', 'false' );
			if ( ! trigger.attr( 'aria-haspopup' ) ) trigger.attr( 'aria-haspopup', dropdown ? 'menu' : 'dialog' );
			// A captured image lightbox is a viewport surface. Keeping it below a
			// transformed slide would make fixed positioning and hit ownership local.
			if (state.gallery) gallerySurface($, trigger).append(panel);
			else if ( reusePanel ) {
				existingPanel.replaceWith( panel );
				reusedPanels.set( state.dialog!.selector, panelId );
			}
			else if ( observed?.parent ) {
				if ( observed.before ) $( observed.before ).before( panel );
				else $( observed.parent ).append( panel );
			}
			else trigger.after( panel );
			if ( ! dropdown && !state.gallery ) {
				const close = $( '<button type="button" hidden>Close</button>' );
				close.attr( 'data-blocks-engine-capture-dialog-close', panelId );
				close.attr( 'aria-label', label ? `Close ${ label }` : 'Close' );
				panel.after( close );
			}
			wired++;
		} );
	}
	if ( listboxes > 0 && $( 'script[data-blocks-engine-capture-listbox-runtime]' ).length === 0 )
		$( 'head' ).append( `<script data-blocks-engine-capture-listbox-runtime="true">${ LISTBOX_RUNTIME }</script>` );
	if ( choiceConfigs.length > 0 && $( 'script[data-blocks-engine-capture-choice-runtime]' ).length === 0 ) {
		const config = JSON.stringify( choiceConfigs ).replace( /</g, '\\u003c' );
		$( 'head' ).append(
			`<script data-blocks-engine-capture-choice-runtime="true">${ CHOICE_GROUP_RUNTIME.replace( '__DLA_CHOICE_CONFIG__', config ) }</script>`
		);
	}
	for ( const state of initialDialogs ) {
		if ( state.status !== 'captured' || !state.dismissal?.verified || state.dialog.htmlTruncated ) continue;
		const panel = $( '<div class="data-blocks-engine-capture-dialog" role="dialog" aria-modal="true"></div>' );
		if ( state.dialog.ariaLabel ) panel.attr( 'aria-label', state.dialog.ariaLabel );
		panel.html( state.dialog.html );
		const close = findCloseControl( $, panel as cheerio.Cheerio< Element >, state.dismissal.control );
		if ( !close.length ) continue;
		const summary = $( '<summary></summary>' );
		for ( const [ name, value ] of Object.entries( close.attr() ?? {} ) ) {
			if ( name !== 'type' && name !== 'id' ) summary.attr( name, value );
		}
		summary.html( close.html() ?? state.dismissal.control.label ?? 'Close' );
		close.remove();
		const details = $( '<details class="data-blocks-engine-capture-disclosure data-blocks-engine-capture-initial-dialog" open></details>' );
		details.append( summary, panel );
		$( 'body' ).append( details );
		wired++;
	}
	if ( wired > 0 || $('[data-blocks-engine-capture-dialog-trigger]').length > 0 ) {
		// Styles the source added only once a panel opened (for example utility
		// classes compiled on demand) travel with the panel they style.
		const panelCss = [ ...new Set( captured.map( ( state ) => state.dialog?.css ?? '' ).filter( Boolean ) ) ].join( '\n' );
		if ( panelCss && $( 'style[data-blocks-engine-capture-dialog-css]' ).length === 0 ) {
			$( 'head' ).append( `<style data-blocks-engine-capture-dialog-css="true">${ panelCss.replace( /<\/style/gi, '<\\/style' ) }</style>` );
		}
		if ( $( 'style[data-blocks-engine-capture-disclosure]' ).length === 0 ) {
			$( 'head' ).append( `<style data-blocks-engine-capture-disclosure="true">${ DISCLOSURE_CSS }</style>` );
		}
		if ( $( 'style[data-blocks-engine-capture-disclosure-base]' ).length === 0 ) {
			// First in <head>: a layer's priority is fixed where it is first
			// declared, so this must precede any author `@layer` statement.
			$( 'head' ).prepend( `<style data-blocks-engine-capture-disclosure-base="true">${ DISCLOSURE_BASE_CSS }</style>` );
		}
		if ( $( 'script[data-blocks-engine-capture-disclosure-runtime]' ).length === 0 ) {
			$( 'head' ).append(
				`<script data-blocks-engine-capture-disclosure-runtime="true">${ DISCLOSURE_RUNTIME }</script>`
			);
		}
	}
	if (localDisclosures && $('script[data-blocks-engine-capture-local-disclosure-runtime]').length === 0) {
		if ($('style[data-blocks-engine-capture-local-disclosure]').length === 0) {
			$('head').append('<style data-blocks-engine-capture-local-disclosure="true">[data-blocks-engine-capture-local-disclosure][hidden]{display:none!important}</style>');
		}
		$('head').append(`<script data-blocks-engine-capture-local-disclosure-runtime="true">${LOCAL_DISCLOSURE_RUNTIME}</script>`);
	}
	return $.html();
}

/** Replace only the exact navigation button whose source click changed routes. */
export function wireCapturedRouteNavigation( html: string, routes: CapturedRouteNavigation[] ): string {
	if ( routes.length === 0 ) return html;
	const $ = cheerio.load( html );
	let changed = false;
	for ( const route of routes ) {
		if ( route.siblings.length < 2 ) continue;
		// Responsive document merging may add wrappers or retain two device copies.
		// The observed sibling group, not a bare label, identifies those copies.
		$( 'nav button,[role="navigation"] button' ).each( ( _, element ) => {
			const button = $( element );
			if ( button.closest( 'form,a,details' ).length ) return;
			if ( normalizedText( button.attr( 'aria-label' ) || button.text() ) !== route.label ) return;
			const siblings = button.parent().children( 'button,a' ).map( ( __, sibling ) =>
				normalizedText( $( sibling ).attr( 'aria-label' ) || $( sibling ).text() )
			).get();
			if ( siblings.join( '\u0000' ) !== route.siblings.join( '\u0000' ) ) return;
			const link = $( '<a></a>' );
			for ( const [ name, value ] of Object.entries( button.attr() ?? {} ) ) {
				if ( name === 'type' || name === 'disabled' || name.startsWith( 'on' ) || name === 'role' ) continue;
				link.attr( name, value );
			}
			link.attr( 'href', route.url ).html( button.html() ?? '' );
			button.replaceWith( link );
			changed = true;
		} );
	}
	if ( changed ) {
		// Empty fixed toaster shells can sit over the bottom tabs at tablet widths.
		// They have no content or controls to preserve, but still intercept clicks.
		$( 'div' ).toArray().reverse().forEach( element => {
			const shell = $( element );
			const classes = shell.attr( 'class' ) ?? '';
			if ( shell.children().length || normalizedText( shell.text() ) || shell.attr( 'role' ) || shell.attr( 'aria-label' ) ) return;
			if ( /(?:^|\s)fixed(?:\s|$)/.test( classes ) && /(?:^|\s)z-\S+/.test( classes ) ) shell.remove();
		} );
	}
	return changed ? $.html() : html;
}

function nextDialogId( $: cheerio.CheerioAPI ): string {
	let index = 0;
	while ( $( `#data-blocks-engine-capture-dialog-${ index }` ).length ) index++;
	return `data-blocks-engine-capture-dialog-${ index }`;
}

function gallerySurface($: cheerio.CheerioAPI, trigger: cheerio.Cheerio<AnyNode>) {
	const document = trigger.closest('.data-blocks-engine-capture-desktop-document,.data-blocks-engine-capture-mobile-document,[class*="site-document-variant-"]');
	return document.length ? document : $('body');
}

function classTokens( value: string | null ): string[] {
	return ( value ?? '' ).split( /\s+/ ).filter( Boolean );
}

/**
 * Bind verified source evidence only to the unchanged local portable owner.
 * A dropdown also needs its proven source slot; a modal keeps its own mount
 * and replays only the ancestor changes.
 */
function resolveObservedAncestors(
	$: cheerio.CheerioAPI,
	trigger: cheerio.Cheerio< AnyNode >,
	state: CapturedDropdownAncestorState | undefined,
	dropdown: boolean
): { state: CapturedDropdownAncestorState; parent?: Element; before?: Element } | undefined {
	if ( state?.status !== 'verified' || dropdown && !state.placement || !Array.isArray( state.ancestors ) || state.ancestors.length > 8 || JSON.stringify( state ).length > 32768 ) return undefined;
	if ( !dropdown && state.ancestors.length === 0 ) return undefined;
	const parents = trigger.parents().toArray();
	for ( const row of state.ancestors ) {
		if ( !row || !row.closed || !row.opened ) return undefined;
		if ( !Number.isInteger( row.depth ) || row.depth < 1 || row.depth > 8 ) return undefined;
		const node = parents[ row.depth - 1 ];
		if ( !node || node.tagName !== row.tag || !selectByCapturedSelector( $, row.selector, row.tag ).toArray().includes( node ) ) return undefined;
		const names = Object.keys( row.closed );
		if ( names.length > 32 || names.length !== Object.keys( row.opened ).length ) return undefined;
		for ( const name of names ) {
			if ( !DROPDOWN_ANCESTOR_ATTRIBUTE_PATTERN.test( name ) ) return undefined;
			const closed = row.closed[ name ], opened = row.opened[ name ];
			if ( [ closed, opened ].some( value => value !== null && ( typeof value !== 'string' || Buffer.byteLength( value ) > 2048 ) ) ) return undefined;
			if ( closed === opened ) continue;
			// Class is replayed as tokens: the portable owner must still carry the
			// closed tokens (all of them, when the full list was recorded).
			const current = $( node ).attr( name ) ?? null;
			if ( name === 'class' ? !classTokens( closed ).every( token => classTokens( current ).includes( token ) ) : current !== closed ) return undefined;
		}
	}
	if ( !dropdown || !state.placement ) return { state };
	const parent = parents[ state.placement.parentDepth - 1 ];
	if ( !parent || !selectByCapturedSelector( $, state.placement.parentSelector, parent.tagName ).toArray().includes( parent ) ) return undefined;
	if ( ![ 'static', 'relative', 'absolute', 'fixed', 'sticky' ].includes( state.placement.position ) ) return undefined;
	const beforeNodes = state.placement.beforeSelector ? selectByCapturedSelector( $, state.placement.beforeSelector, undefined ).toArray().filter( ( node ): node is Element => node.type === 'tag' && node.parent === parent ) : [];
	if ( state.placement.beforeSelector && beforeNodes.length !== 1 ) return undefined;
	return { state, parent, ...( beforeNodes[ 0 ] ? { before: beforeNodes[ 0 ] } : {} ) };
}

function removeCapturedDialog( $: cheerio.CheerioAPI, selector: string | undefined ): void {
	if ( ! selector ) return;
	try {
		$( selector ).not( 'details.data-blocks-engine-capture-disclosure *, [data-blocks-engine-capture-dialog-panel], [data-blocks-engine-capture-dialog-panel] *' ).each( ( _, element ) => {
			let ancestor = $( element ).parent();
			$( element ).remove();
			// Relocation can vacate a whole chain of source wrappers. Prune only
			// that chain, within body, without deleting semantic landmarks.
			while ( ancestor.parents( 'body' ).length && !ancestor.is( 'header,nav,main,aside,footer,section,form,search' ) ) {
				const roles = ( ancestor.attr( 'role' ) ?? '' ).split( /\s+/ );
				if ( roles.some( role => [ 'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'form', 'search' ].includes( role ) ) ) break;
				if ( ancestor.children().length || ancestor.text().trim() ) break;
				const parent = ancestor.parent();
				ancestor.remove();
				ancestor = parent;
			}
		} );
	} catch {
		// Invalid source selectors cannot safely identify a node to remove.
	}
}

function findCloseControl(
	$: cheerio.CheerioAPI,
	dialog: cheerio.Cheerio< Element >,
	control: NonNullable< CapturedInitialDialog[ 'dismissal' ] >[ 'control' ]
) {
	if ( control.selector.startsWith( '#' ) ) {
		const byId = dialog.find( control.selector ).first();
		if ( byId.length ) return byId;
	}
	const label = ( control.label ?? '' ).replace( /\s+/g, ' ' ).trim().toLowerCase();
	return dialog
		.find(
			'[aria-label*="close" i],[title*="close" i],button[class*="close" i],[data-dismiss],[data-testid*="close" i]'
		)
		.filter( ( _, element ) => {
			if ( element.tagName !== control.tag ) return false;
			if ( !label ) return true;
			const text = ( $( element ).attr( 'aria-label' ) || $( element ).text() )
				.replace( /\s+/g, ' ' )
				.trim()
				.toLowerCase();
			return text === label;
		} )
		.first();
}

function findTriggers(
	$: cheerio.CheerioAPI,
	trigger: CapturedDialogInteraction[ 'trigger' ]
) {
	if ( trigger.id ) {
		const byId = $( `#${ cssEscape( trigger.id ) }` );
		if ( byId.length ) return byId;
	}
	const bySelector = selectByCapturedSelector( $, trigger.selector, trigger.tag );
	if ( bySelector.length ) return bySelector;
	const label = ( trigger.label ?? '' ).replace( /\s+/g, ' ' ).trim().toLowerCase();
	if ( ! label ) return $( [] );
	return $( 'button,summary,a,[role="button"]' ).filter( ( _, element ) => {
		if ( trigger.tag && element.tagName !== trigger.tag ) return false;
		if ( isNavigatingAnchor( $, element ) ) return false;
		const text = ( $( element ).attr( 'aria-label' ) || $( element ).text() )
			.replace( /\s+/g, ' ' )
			.trim()
			.toLowerCase();
		if ( ! text ) return false;
		return text.includes( label ) || label.includes( text );
	} );
}

function selectByCapturedSelector(
	$: cheerio.CheerioAPI,
	selector: string | undefined,
	tag: string | undefined
) {
	if ( ! selector ) return $( [] );
	try {
		const matches = $( selector );
		if ( ! tag ) return matches;
		return matches.filter( ( _, element ) => ( element as Element ).tagName === tag );
	} catch {
		return $( [] );
	}
}

function isNavigatingAnchor( $: cheerio.CheerioAPI, element: Element ): boolean {
	if ( element.tagName !== 'a' ) return false;
	const href = ( $( element ).attr( 'href' ) ?? '' ).trim();
	if ( ! href || href === '#' || href.startsWith( '#' ) ) return false;
	const scheme = href.split( ':', 1 )[ 0 ]!.toLowerCase();
	return scheme !== 'javascript';
}

function cssEscape( value: string ): string {
	return value.replace( /([^a-zA-Z0-9_-])/g, '\\$1' );
}

function normalizedText( value: string ): string {
	return value.replace( /\s+/g, ' ' ).trim();
}
