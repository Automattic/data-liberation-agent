import type { SourceBehavior } from './screenshot/behavior-capture.js';
import { timeDependentTargets } from './behavior-model.js';

export interface ClockBinding { selector: string; role: string; confidence: 'two_controlled_dates' }

/** Match dynamic targets against controlled local time semantics, never their ID or source text labels. */
export function learnClockBindings( first: SourceBehavior, second: SourceBehavior ): { bindings: ClockBinding[]; unsupported: string[] } {
	const bindings: ClockBinding[] = [];
	const unsupported: string[] = [];
	for ( const selector of timeDependentTargets( first, second ) ) {
		const a = first.startup.settledText?.[ selector ]?.trim();
		const b = second.startup.settledText?.[ selector ]?.trim();
		const roles = Object.keys( first.clockSamples ?? {} ).filter( ( role ) => a === first.clockSamples?.[ role ] && b === second.clockSamples?.[ role ] );
		if ( roles.length === 1 ) bindings.push( { selector, role: roles[ 0 ], confidence: 'two_controlled_dates' } );
		else unsupported.push( selector );
	}
	return { bindings, unsupported };
}

export function compileClockBehavior( bindings: ClockBinding[] ): string {
	return `(function(){
const bindings=${ JSON.stringify( bindings ).replace( /</g, '\\u003c' ) };
function values(){
const now=new Date(),two=value=>String(value).padStart(2,'0'),locale=document.documentElement.lang||'en-US';
const parts=new Intl.DateTimeFormat(locale,{weekday:'long',month:'short',day:'numeric',year:'numeric'}).formatToParts(now),part=type=>(parts.find(value=>value.type===type)||{}).value||'';
const offset=-now.getTimezoneOffset()/60;
return {hour12:two(now.getHours()%12||12),hour24:two(now.getHours()),minute:two(now.getMinutes()),ampm:now.getHours()<12?'AM':'PM',iso:now.toISOString(),gmtOffset:'(GMT '+(offset>=0?'+':'')+offset+')',dateUpper:(part('weekday')+', '+part('month')+' '+part('day')+', '+part('year')).toUpperCase()};
}
function update(){const current=values();for(const binding of bindings){const node=document.querySelector(binding.selector);if(node&&!node.children.length&&current[binding.role]!==undefined)node.textContent=current[binding.role]}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',update,{once:true});else update();setInterval(update,1000);
})();`;
}
