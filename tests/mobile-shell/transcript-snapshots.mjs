import assert from 'node:assert/strict';

export async function transcriptSnapshotScenario(api, f, prefix) {
 const original=f.store.getSession.bind(f.store),render=f.ctx.host.renderMarkdown,reads=[],sources=[];let count=0;
 f.store.getSession=id=>{count++;return original(id);};
 f.ctx.host.renderMarkdown=(text,element,path)=>{sources.push(path);render(text,element,path);};
 try {
  const id=f.store.session.id;
  for(const length of [2,200]) {
   await f.store.patchSession(id,{taskStatus:'completed',notePath:'source.md',messages:Array.from({length},(_,index)=>({role:index%2?'assistant':'user',content:[{type:'text',text:'固定消息 '+index}],timestamp:index+1}))});
   count=0;sources.length=0;const page=api.createTaskPage(f.ctx,id);
   try {
    reads.push(count);assert.equal(page.content.querySelectorAll(`.${prefix}-task-answer`).length,length/2);
    assert.equal(sources.length,length/2);assert.ok(sources.every(path=>path==='source.md'));
    sources.length=0;await f.store.patchSession(id,{notePath:'changed-source.md'});f.runtime.onChange();
    assert.equal(sources.length,length/2,'source path changes must invalidate completed Markdown');assert.ok(sources.every(path=>path==='changed-source.md'));
   } finally {page.dispose();}
  }
  assert.ok(reads[1]<=reads[0]+2,`Opening 100 answers must not clone the full task per row: ${reads}`);
 } finally {f.store.getSession=original;f.ctx.host.renderMarkdown=render;}
}
