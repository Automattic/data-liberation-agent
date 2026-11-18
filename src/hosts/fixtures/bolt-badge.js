// Reduced from https://bolt.new/badge.js (fetched for issue #2006): the same
// host element, inline styles, shadow-root markup and insertion timing, without
// the embedded font and badge artwork.
"use strict";(()=>{
let s=document.createElement("div");
Object.assign(s.style,{position:"fixed",bottom:"1rem",right:"1rem",zIndex:"2147483647"});
let i=s.attachShadow({mode:"open"});
i.innerHTML=`<div style="position: relative"><div class="badge-container"><a class="badge"></a><button class="dismiss" type="button" aria-label="Hide the Made in Bolt badge"></button></div><div class="dialog"></div></div><style></style>`;
let t=i.querySelector(".badge-container");
Object.assign(t.style,{borderRadius:"8px",border:"1px solid #E1F2FF",background:"white",display:"flex",alignItems:"stretch",overflow:"hidden",scale:"0.8"});
let n=i.querySelector(".badge");
n.textContent="Made in Bolt";n.href="https://bolt.new";n.target="_blank";n.style.padding="8px 12px";
let A=document.createElement("style");
A.innerHTML="@font-face {font-family: SchibstedGrotesk-NjBkMDQwOTZj; font-weight: 600; src: local(Arial)}";
let x=false;
function S(){x||(x=true,document.body.appendChild(A),document.body.appendChild(s))}
setTimeout(S,1500);document.addEventListener("DOMContentLoaded",S);
})();
