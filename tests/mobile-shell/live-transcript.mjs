import assert from 'node:assert/strict';

export async function liveTranscriptScenarios(api, window, test) {
 const {document}=window,wait=()=>new Promise(r=>setTimeout(r,35));
 await test('mobile scroll frame batches all reads before writes and replaces duplicate work',async()=>{
  const frame=new api.MobileScrollFrame(window),a={},b={},order=[];
  frame.request(a,()=>{order.push('obsolete');});
  frame.request(a,()=>{order.push('read-a');return()=>order.push('write-a');});
  frame.request(b,()=>{order.push('read-b');return()=>order.push('write-b');});
  await wait();assert.deepEqual(order,['read-a','read-b','write-a','write-b']);
 });
 for(const prefix of ['ip','pd'])await test(`${prefix} live nodes keep selection/reading, then transfer reasoning without re-rendering the saved row`,async()=>{
  const host=document.createElement('main'),live=document.createElement('div'),archive=document.createElement('div');host.append(live,archive);document.body.append(host);
  let allow=true,writes=0,top=0,reason='想'.repeat(80);
  const view=new api.MobileLiveTaskTranscript(live,prefix,open=>{
   const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
   summary.append(document.createElement('span'),document.createElement('span'));details.append(summary,body);details.open=open;body.className=prefix+'-task-reasoning-body';
   Object.defineProperties(body,{clientHeight:{get:()=>120},scrollHeight:{get:()=>body.textContent.length*4},scrollTop:{get:()=>top,set:value=>{writes++;top=value;}}});return details;
  },()=>allow,()=>allow=false,()=>allow=true);
  try{
   view.render({reasoning:reason,text:''});await wait();
   const details=live.querySelector('details'),summary=details.querySelector('summary'),body=details.querySelector('div'),reasonText=body.firstChild;
   body.dispatchEvent(new window.Event('touchstart'));top=20;body.dispatchEvent(new window.Event('scroll'));writes=0;
   reason+='继续';view.render({reasoning:reason,text:'正文'});await wait();
   assert.equal(top,20);assert.equal(writes,0);assert.equal(live.querySelector('details'),details);assert.equal(details.querySelector('summary'),summary);assert.equal(body.firstChild,reasonText);assert.equal(details.open,true,'manual reading prevents default answer-time collapse');
   const article=live.querySelector('article'),text=article.firstChild,range=document.createRange();range.setStart(text,0);range.setEnd(text,2);
   view.render({reasoning:reason,text:'正文追加'});assert.equal(article.firstChild,text);assert.equal(range.toString(),'正文');
   body.dispatchEvent(new window.Event('touchend'));await wait();assert.equal(top,20);assert.equal(writes,0);
   top=body.scrollHeight-body.clientHeight;body.dispatchEvent(new window.Event('scroll'));await wait();
   writes=0;reason+='最后';view.render({reasoning:reason,text:'正文追加'});view.render({reasoning:reason+'一段',text:'正文追加'});await wait();assert.equal(writes,1,'one target writes once in its content frame');
   const finalReason=reason+'一段',nodes=new api.MobileTranscriptNodes();nodes.begin();const saved=nodes.get('reason',finalReason,()=>view.takeReasoning(finalReason));nodes.commit(archive,[saved]);
   view.render(undefined);assert.equal(saved,details);assert.equal(saved.isConnected,true);assert.equal(archive.firstChild,details);assert.equal(details.open,true);
   nodes.begin();assert.equal(nodes.get('reason',finalReason,()=>{throw Error('must retain saved node');}),saved);nodes.commit(archive,[saved]);
   view.dispose();view.render({reasoning:'stale',text:'stale'});await wait();assert.equal(live.childNodes.length,0,'late updates cannot revive a disposed live slot');nodes.clear();
  }finally{view.dispose();host.remove();}
 });
}
