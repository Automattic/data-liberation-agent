import { learnTextReveals, type LearnedTextReveal } from './behavior-model.js';
import type { SourceBehavior } from './screenshot/behavior-capture.js';

export interface TextBehaviorProgram {
	schema: 'data-liberation/text-behavior/v1';
	startup: LearnedTextReveal[];
	replays: Array< { trigger: string; steps: LearnedTextReveal[] } >;
}

/** A small compiler from browser evidence to editable, DOM-bound behavior. */
export function compileTextBehavior( observed: SourceBehavior, dynamicTime: string[] = [] ): { program: TextBehaviorProgram; script: string } {
	const exclude = new Set( dynamicTime );
	const startup = learnTextReveals( observed.startup ).filter( ( step ) => ! exclude.has( step.selector ) );
	const replays = observed.replays.map( ( replay ) => ( { trigger: replay.selector, steps: learnTextReveals( replay.trace ).filter( ( step ) => ! exclude.has( step.selector ) ) } ) ).filter( ( replay ) => replay.steps.length );
	const program: TextBehaviorProgram = { schema: 'data-liberation/text-behavior/v1', startup, replays };
	// No editorial text is embedded in the generated program. Capture the current
	// saved DOM text once, before changing it; future edited exports replay edits.
	const script = `(function(){
const program=${ JSON.stringify( program ).replace( /</g, '\\u003c' ) };
function mount(){
 const targets=new Map(),running=new Set();
 for(const step of [...program.startup,...program.replays.flatMap(row=>row.steps)]){
  if(targets.has(step.selector))continue;
  const element=document.querySelector(step.selector);
  if(element&&!element.children.length)targets.set(step.selector,{element,text:element.textContent||''});
 }
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function play(steps){
  const active=steps.filter(step=>targets.has(step.selector)&&!running.has(step.selector));
  active.forEach(step=>{running.add(step.selector);targets.get(step.selector).element.textContent=''});
  await Promise.all(active.map(async step=>{
   const target=targets.get(step.selector);await wait(step.startMs);
   for(const character of Array.from(target.text)){target.element.textContent+=character;await wait(step.intervalMs)}
   running.delete(step.selector);
  }));
 }
 for(const replay of program.replays){const trigger=document.querySelector(replay.trigger);if(trigger)trigger.addEventListener('click',()=>void play(replay.steps))}
 void play(program.startup).then(()=>document.documentElement.dataset.dlaTextReady='true');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();`;
	return { program, script };
}
