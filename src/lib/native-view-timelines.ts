import * as cheerio from 'cheerio';

/** Owned portable runtime, injected only after source scripts have been removed.
 * Native WAAPI preserves multiple effects and their composition without replacing
 * an authored CSS animation list. The browser still owns scroll progress.
 */
export const NATIVE_VIEW_TIMELINE_RUNTIME = `(()=>{
const mounted=new WeakMap();
function mount(){
 if(typeof ViewTimeline==='undefined'){document.querySelectorAll('[data-dla-native-effects]').forEach(target=>target.setAttribute('data-dla-native-runtime-loss','ViewTimeline unavailable'));return}
 document.querySelectorAll('[data-dla-native-effects]').forEach(target=>{
  const rendered=target.getClientRects().length>0;
  if(mounted.has(target)){if(rendered)return;mounted.get(target).forEach(dispose=>dispose());mounted.delete(target)}
  if(!rendered)return;
  const scope=target.closest('[data-dla-document-scope]')||document;
  const find=token=>{const candidates=Array.from(scope.querySelectorAll('[data-dla-native-node]'));if(scope instanceof Element&&scope.hasAttribute('data-dla-native-node'))candidates.unshift(scope);const nodes=candidates.filter(node=>node.getAttribute('data-dla-native-node')===token&&(node.closest('[data-dla-document-scope]')||document)===scope);return nodes.length===1?nodes[0]:null};
  let configs;try{configs=JSON.parse(target.getAttribute('data-dla-native-effects'))}catch{return}
  if(!Array.isArray(configs))return;
  const disposers=[];mounted.set(target,disposers);
  configs.forEach(config=>{
   const subject=find(config.subject),source=config.source==='root'?document.scrollingElement:find(config.source);
    if(!subject||!source){target.setAttribute('data-dla-native-runtime-loss','subject or source binding missing or ambiguous');return}
   try{
    const timeline=new ViewTimeline({subject,axis:config.axis,inset:config.inset});
    if(timeline.source!==source){target.setAttribute('data-dla-native-runtime-loss','timeline source changed');return}
    const effect=new KeyframeEffect(target,config.frames,{...config.timing,composite:config.composite});
    const animation=new Animation(effect,timeline);
    const horizontal=getComputedStyle(source).writingMode==='horizontal-tb',vertical=config.axis==='y'||(config.axis==='block'&&horizontal)||(config.axis==='inline'&&!horizontal);
    const extent=node=>vertical?node.clientHeight:node.clientWidth;
    function update(){for(const name of ['rangeStart','rangeEnd']){const range=config[name];animation[name]=range.coverExtent?'cover calc(0% + '+(extent(subject)+extent(source))+'px)':range.value}}
    update();animation.play();
    disposers.push(()=>animation.cancel());
    if(config.rangeStart.coverExtent||config.rangeEnd.coverExtent){const observer=new ResizeObserver(update);observer.observe(subject);observer.observe(source);addEventListener('resize',update);disposers.push(()=>{observer.disconnect();removeEventListener('resize',update)})}
   }catch(error){target.setAttribute('data-dla-native-runtime-loss',String(error))}
  });
 });
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
addEventListener('resize',mount);
})();`;

export function wireNativeViewTimelines( html: string ): string {
	if ( ! html.includes( 'data-dla-native-effects=' ) ) return html;
	const $ = cheerio.load( html );
	if ( ! $( '[data-dla-native-effects]' ).length ) return html;
	$( 'script[data-dla-native-view-timeline-runtime]' ).remove();
	$( 'head' ).append( `<script data-dla-native-view-timeline-runtime>${ NATIVE_VIEW_TIMELINE_RUNTIME }</script>` );
	return $.html();
}
