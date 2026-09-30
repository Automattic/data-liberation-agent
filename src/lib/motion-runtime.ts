/**
 * Portable interpreter for the Blocks Engine motion marker vocabulary
 * (`data-blocks-engine-motion-steps`, `data-blocks-engine-live-clock`). Blocks
 * Engine lowers the same inert markers to editable blocks whose view scripts
 * implement this contract in WordPress; this file is the static-site side.
 * It reads editable text from the current DOM and embeds no page content.
 */
export const MOTION_RUNTIME = `(function(){
var active=0,previousBusy=null;
function beginBusy(){if(active++===0){previousBusy=document.body.getAttribute('aria-busy');document.body.setAttribute('aria-busy','true')}}
function endBusy(){if(--active===0){if(previousBusy===null)document.body.removeAttribute('aria-busy');else document.body.setAttribute('aria-busy',previousBusy)}}
function select(selector){if(typeof selector!=='string'||selector.length>120)return null;try{return document.querySelector(selector)}catch(error){return null}}
function textTarget(selector){var element=select(selector);if(!element)return null;if(!element.children.length)return element;var child=element.firstElementChild;return element.children.length===1&&child.tagName==='P'&&!child.children.length?child:null}
function bounded(value,fallback,min,max){if(value===undefined||value===null||value==='')return fallback;var number=Number(value);return Number.isFinite(number)&&number>=min&&number<=max?number:fallback}
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
function reveals(list){return(Array.isArray(list)?list:[]).slice(0,8).map(function(item){var element=item&&select(item.selector);if(!element)return null;var property=item.hideWith==='display'?'display':'visibility';return{element:element,property:property,hidden:property==='display'?'none':'hidden',original:element.style.getPropertyValue(property),priority:element.style.getPropertyPriority(property)}}).filter(Boolean)}
function hide(list){list.forEach(function(item){item.element.style.setProperty(item.property,item.hidden,'important')})}
function show(list){list.forEach(function(item){if(item.original)item.element.style.setProperty(item.property,item.original,item.priority);else item.element.style.removeProperty(item.property)})}
function mountSteps(marker){
 var input;try{input=JSON.parse(marker.getAttribute('data-blocks-engine-motion-steps')||'[]')}catch(error){return}
 if(!Array.isArray(input))return;
 var steps=input.slice(0,8).map(function(item){if(!item||typeof item!=='object')return null;var target=textTarget(item.selector);if(!target)return null;var text=target.textContent||'';if(text.length>500)return null;
  return{target:target,text:Array.from(text),delay:bounded(item.delayMs,500,0,5000),interval:bounded(item.intervalMs,50,10,500),pending:typeof item.pendingText==='string'?item.pendingText.slice(0,120):'',pendingDots:item.pendingDots===true,pendingInterval:bounded(item.pendingIntervalMs,500,100,2000),replayDelay:bounded(item.replayDelayMs,0,0,5000),click:select(item.clickSelector),reveal:reveals(item.revealSelectors),timer:null,running:false}}).filter(Boolean);
 if(!steps.length)return;
 beginBusy();
 function showPending(step){if(step.timer!==null)clearInterval(step.timer);hide(step.reveal);step.target.textContent=step.pending;if(step.pending&&step.pendingDots){var dots=0;step.timer=setInterval(function(){dots=(dots+1)%4;step.target.textContent=step.pending+'.'.repeat(dots)},step.pendingInterval)}else step.timer=null}
 function endPending(step){if(step.timer!==null)clearInterval(step.timer);step.timer=null;step.target.textContent=''}
 async function play(step,first){if(step.running)return;step.running=true;showPending(step);var ms=first?step.delay:step.replayDelay;if(ms)await wait(ms);endPending(step);show(step.reveal);for(var index=0;index<step.text.length;index++){step.target.textContent+=step.text[index];await wait(step.interval)}step.running=false}
 steps.forEach(function(step){if(step.click)step.click.addEventListener('click',function(){if(!marker.dataset.blocksEngineMotionReady)return;beginBusy();void play(step,false).finally(endBusy)});showPending(step)});
 (async function(){try{for(var index=0;index<steps.length;index++)await play(steps[index],true);marker.dataset.blocksEngineMotionReady='true'}finally{endBusy()}})();
}
function dateText(date,locale){try{var parts=new Intl.DateTimeFormat(locale,{weekday:'long',month:'short',day:'numeric',year:'numeric'}).formatToParts(date);var part=function(type){return(parts.find(function(item){return item.type===type})||{}).value||''};return(part('weekday')+', '+part('month')+' '+part('day')+', '+part('year')).toUpperCase()}catch(error){return''}}
function mountClock(marker){
 var config;try{config=JSON.parse(marker.getAttribute('data-blocks-engine-live-clock')||'{}')}catch(error){return}
 if(!config||typeof config!=='object'||Array.isArray(config))return;
 var hours=select(config.hourSelector),minutes=select(config.minuteSelector),timezone=select(config.timezoneSelector);
 if(!hours||!minutes||!timezone||hours.children.length||minutes.children.length||timezone.children.length)return;
 var ampm=select(config.ampmSelector),date=textTarget(config.dateSelector),trigger=select(config.triggerSelector);
 var stages=typeof config.stages==='string'?config.stages.split(',').map(function(value){return value.trim()}).filter(Boolean).slice(0,8):[];
 var running=false,showingTime=false,initialFrame=typeof config.initialFrame==='string'&&config.initialFrame.length<=8?config.initialFrame:'';
 function currentTime(){if(!showingTime)return;var now=new Date(),hour=now.getHours();if(ampm)ampm.textContent=config.hourCycle==='24'?'':(hour<12?'AM':'PM');if(config.hourCycle!=='24')hour=hour%12||12;hours.textContent=String(hour).padStart(2,'0');minutes.textContent=String(now.getMinutes()).padStart(2,'0');var offset=-now.getTimezoneOffset()/60;timezone.textContent='(GMT '+(offset>=0?'+':'')+offset+')'}
 async function replay(){if(running)return;running=true;showingTime=false;if(date&&!date.children.length)date.textContent='';var interval=bounded(config.stageDurationMs,150,0,1000);for(var index=0;index<stages.length;index++){hours.textContent=stages[index];minutes.textContent=stages[index];await wait(interval)}await wait(bounded(config.pauseMs,200,0,1000));showingTime=true;currentTime();
  if(date&&!date.children.length){await wait(bounded(config.dateDelayMs,500,0,1000));var text=Array.from(dateText(new Date(),config.locale||'en-US'));var characterInterval=bounded(config.characterIntervalMs,50,0,500);for(var letter=0;letter<text.length;letter++){date.textContent+=text[letter];await wait(characterInterval)}}
  running=false;marker.dataset.blocksEngineClockReady='true'}
 setInterval(currentTime,1000);
 if(initialFrame){hours.textContent=initialFrame;minutes.textContent=initialFrame}
 if(ampm)ampm.textContent='';timezone.textContent='';if(date&&!date.children.length)date.textContent='';
 var startupTimer=setTimeout(function(){void replay()},bounded(config.startDelayMs,0,0,5000));
 if(trigger)trigger.addEventListener('click',function(){clearTimeout(startupTimer);void replay()});
}
function mountAll(){document.querySelectorAll('[data-blocks-engine-live-clock]').forEach(mountClock);document.querySelectorAll('[data-blocks-engine-motion-steps]').forEach(mountSteps)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountAll);else mountAll();
})();`;
