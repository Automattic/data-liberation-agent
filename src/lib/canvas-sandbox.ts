/**
 * Runs a source's own canvas code on a page whose text and layout are owned
 * by editable content. The source code sees a membrane over the DOM:
 *
 * - canvas elements and their drawing contexts are fully live;
 * - pointer, click and other event listeners attach to the real elements;
 * - reads (text, geometry, computed style) return real values;
 * - every write to a non-canvas node (text, attributes, style, classes, tree
 *   changes) is discarded, so editable content is never overwritten.
 *
 * Nothing about any particular site is assumed. Scripts that cannot run under
 * the membrane simply fail the live pointer verification and stay unpromoted.
 */
const MEMBRANE = String.raw`
var realDoc=document,realWin=window,toReal=new WeakMap(),toProxy=new WeakMap(),listeners=new WeakMap(),inert=new Map();
var MUTATORS=new Set(['appendChild','append','prepend','insertBefore','replaceChild','removeChild','remove','replaceWith','before','after','insertAdjacentHTML','insertAdjacentElement','insertAdjacentText','setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute','setAttributeNode','replaceChildren','normalize','click','focus','blur','scrollIntoView','requestFullscreen','attachShadow','animate','showModal','show','close','submit','reset']);
var WRAPPED=['target','currentTarget','srcElement','relatedTarget','view'];
function isCanvas(v){return typeof HTMLCanvasElement!=='undefined'&&v instanceof HTMLCanvasElement}
function isContext(v){return(typeof CanvasRenderingContext2D!=='undefined'&&v instanceof CanvasRenderingContext2D)||(typeof WebGLRenderingContext!=='undefined'&&v instanceof WebGLRenderingContext)||(typeof WebGL2RenderingContext!=='undefined'&&v instanceof WebGL2RenderingContext)}
function unwrap(v){return v&&(typeof v==='object'||typeof v==='function')&&toReal.has(v)?toReal.get(v):v}
function remember(real,proxy){toReal.set(proxy,real);toProxy.set(real,proxy);return proxy}
function isConstructor(name,fn){return typeof name==='string'&&/^[A-Z]/.test(name)&&typeof fn==='function'}
function call(fn,target){return function(){return wrap(fn.apply(target,Array.prototype.map.call(arguments,unwrap)))}}
function handler(fn,self){if(typeof fn!=='function'&&!(fn&&typeof fn.handleEvent==='function'))return fn;var known=listeners.get(fn);if(known)return known;var wrapped=function(event){return typeof fn==='function'?fn.call(self,wrap(event)):fn.handleEvent(wrap(event))};listeners.set(fn,wrapped);return wrapped}
function eventMethod(target,name,self){return function(type,fn,options){return target[name](type,handler(fn,self),options)}}
function wrap(v){
 if(!v||typeof v!=='object'||toReal.has(v))return v;
 if(toProxy.has(v))return toProxy.get(v);
 if(v===realDoc)return doc;
 if(v===realWin)return win;
 if(isContext(v))return live(v);
 if(typeof Node!=='undefined'&&v instanceof Node)return isCanvas(v)?live(v):node(v);
 if((typeof NodeList!=='undefined'&&v instanceof NodeList)||(typeof HTMLCollection!=='undefined'&&v instanceof HTMLCollection)){var list=Array.prototype.map.call(v,wrap);list.item=function(i){return list[i]||null};return list}
 if(typeof Event!=='undefined'&&v instanceof Event)return reader(v,true);
 if(typeof MutationRecord!=='undefined'&&v instanceof MutationRecord)return reader(v,false);
 if(typeof IntersectionObserverEntry!=='undefined'&&v instanceof IntersectionObserverEntry)return reader(v,false);
 if(typeof ResizeObserverEntry!=='undefined'&&v instanceof ResizeObserverEntry)return reader(v,false);
 return v}
function reader(real,uncached){var proxy=new Proxy(real,{get:function(t,p){var v=Reflect.get(t,p,t);if(WRAPPED.indexOf(p)!==-1)return wrap(v);return typeof v==='function'?v.bind(t):wrap(v)},set:function(){return true}});return uncached?proxy:remember(real,proxy)}
function live(real){var proxy=new Proxy(real,{get:function(t,p){if(p==='addEventListener'||p==='removeEventListener')return eventMethod(t,p,proxy);var v=Reflect.get(t,p,t);if(typeof v==='function')return isConstructor(p,v)?v:call(v,t);return wrap(v)},set:function(t,p,v){t[p]=typeof p==='string'&&/^on/.test(p)?handler(v,proxy):unwrap(v);return true}});return remember(real,proxy)}
function ignoreSets(real,extra){return new Proxy(real,{get:function(t,p){if(extra&&extra[p])return extra[p](t);var v=Reflect.get(t,p,t);return typeof v==='function'?v.bind(t):v},set:function(){return true},deleteProperty:function(){return true}})}
var styleExtra={setProperty:function(){return function(){}},removeProperty:function(t){return function(name){return t.getPropertyValue(name)}}};
var classExtra={add:function(){return function(){}},remove:function(){return function(){}},replace:function(){return function(){return false}},toggle:function(t){return function(token){return t.contains(token)}}};
function node(real){var proxy=new Proxy(real,{
 get:function(t,p){
  if(p==='addEventListener'||p==='removeEventListener')return eventMethod(t,p,proxy);
  if(p==='style')return ignoreSets(t.style,styleExtra);
  if(p==='classList')return ignoreSets(t.classList,classExtra);
  if(p==='dataset')return ignoreSets(t.dataset);
  if(typeof p==='string'&&MUTATORS.has(p))return function(){
   var args=Array.prototype.map.call(arguments,unwrap);
   // A canvas the source creates may still be attached to the page.
   if(/^(appendChild|append|prepend|insertBefore)$/.test(p)&&args.length&&isCanvas(args[0])&&!args[0].isConnected){t[p].apply(t,args);return arguments[0]}
   return /^(appendChild|removeChild|replaceChild|insertBefore)$/.test(p)?arguments[0]:undefined};
  var v=Reflect.get(t,p,t);
  if(typeof v==='function')return isConstructor(p,v)?v:call(v,t);
  return wrap(v)},
 set:function(t,p,v){if(typeof p==='string'&&/^on/.test(p))t[p]=handler(v,proxy);return true},
 deleteProperty:function(){return true}});return remember(real,proxy)}
var docOverrides={
 getElementById:function(id){var found=realDoc.getElementById(id);if(found)return wrap(found);
  // Content the source would have created is absent; hand back a detached stand-in.
  if(!inert.has(id)){var stand=realDoc.createElement('div');stand.id=String(id);inert.set(id,node(stand))}return inert.get(id)},
 write:function(){},writeln:function(){},open:function(){},close:function(){}};
var doc=remember(realDoc,new Proxy(realDoc,{
 get:function(t,p){if(docOverrides[p])return docOverrides[p];if(p==='addEventListener'||p==='removeEventListener')return eventMethod(t,p,doc);var v=Reflect.get(t,p,t);if(typeof v==='function')return isConstructor(p,v)?v:call(v,t);return wrap(v)},
 set:function(t,p,v){if(typeof p==='string'&&/^on/.test(p))t[p]=handler(v,doc);return true}}));
function observer(Real){if(typeof Real!=='function')return Real;return function(callback,options){var instance=new Real(function(entries,self){return callback(Array.prototype.map.call(entries,wrap),api)},options);var api={observe:function(target,opts){return instance.observe(unwrap(target),opts)},unobserve:function(target){return instance.unobserve(unwrap(target))},disconnect:function(){return instance.disconnect()},takeRecords:function(){return Array.prototype.map.call(instance.takeRecords?instance.takeRecords():[],wrap)}};return api}}
var globals={getComputedStyle:function(element,pseudo){return realWin.getComputedStyle(unwrap(element),pseudo)},MutationObserver:observer(realWin.MutationObserver),ResizeObserver:observer(realWin.ResizeObserver),IntersectionObserver:observer(realWin.IntersectionObserver)};
var win=remember(realWin,new Proxy(realWin,{
 get:function(t,p){if(p==='document')return doc;if(p==='window'||p==='self'||p==='globalThis'||p==='top'||p==='parent'||p==='frames')return win;if(globals[p])return globals[p];if(p==='addEventListener'||p==='removeEventListener')return eventMethod(t,p,win);var v=Reflect.get(t,p,t);if(typeof v==='function')return isConstructor(p,v)?v:call(v,t);return wrap(v)},
 set:function(t,p,v){t[p]=typeof p==='string'&&/^on/.test(p)?handler(v,win):unwrap(v);return true}}));
`;

export interface SandboxedSource { url: string; sha256: string; body: string }

/** A classic script: each source runs inside the membrane with page globals shadowed. */
export function buildCanvasSandbox( sources: SandboxedSource[] ): string {
	const bodies = sources.map( ( source ) => `// ${ source.url.replace( /[\r\n]/g, '' ) } sha256:${ source.sha256 }\n${ source.body }` ).join( '\n;\n' );
	return `(function(){
${ MEMBRANE }
try{(function(document,window,self,globalThis,top,parent,getComputedStyle,MutationObserver,ResizeObserver,IntersectionObserver){
${ bodies }
}).call(win,doc,win,win,win,win,win,globals.getComputedStyle,globals.MutationObserver,globals.ResizeObserver,globals.IntersectionObserver)}catch(error){console.error('[source canvas sandbox]',error)}
})();
`;
}

/** Sources worth sandboxing: their code draws on a canvas. */
export const drawsOnCanvas = ( body: string ): boolean => /\.getContext\s*\(/.test( body );
