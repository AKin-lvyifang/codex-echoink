// Geometry is diagnostic-only: reading every visible element changes measurement cost.
export const installGeometry = `window.__perfGeometry=()=>{
  const values=[];
  for(const e of document.body.querySelectorAll('*')){
    if(!(e instanceof HTMLElement)||e.tagName==='STYLE'||e.tagName==='SCRIPT')continue;
    const r=e.getBoundingClientRect();if(!r.width||!r.height||r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)continue;
    let path=[],n=e;
    for(;n&&n!==document.body;n=n.parentElement){path.push(n.tagName+':'+[...n.parentElement.children].indexOf(n));}
    values.push({key:path.reverse().join('/'),cls:e.className,x:r.x,y:r.y,w:r.width,h:r.height,inList:!!e.closest('.codex-virtual-list'),inProcess:!!e.closest('.codex-assistant-turn-process')});
  }return {t:performance.now(),scroll:v.messagesEl.scrollTop,values};
};`;
export function compareGeometry(before,after){
  const map=new Map(before.values.map(e=>[e.key,e]));
  const moved=after.values.flatMap(e=>{const b=map.get(e.key);return b&&b.cls===e.cls&&(Math.abs(e.x-b.x)>.5||Math.abs(e.y-b.y)>.5)?[{cls:e.cls,dx:e.x-b.x,dy:e.y-b.y,inList:e.inList,inProcess:e.inProcess}]:[];});
  return {before:before.t,after:after.t,scrollBefore:before.scroll,scrollAfter:after.scroll,movedCount:moved.length,movedOutsideList:moved.filter(e=>!e.inList).length,movedOutsideProcess:moved.filter(e=>!e.inProcess).length,moved};
}
