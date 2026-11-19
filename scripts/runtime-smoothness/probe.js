// Executed only in the disposable renderer through CDP. No product files change.
(() => {
  if (window.__smooth) return;
  const s = window.__smooth = {calls:{}, timers:new Map(), events:[], shifts:[], tasks:[], frames:[], restores:[]};
  s.wrap = (obj, key, label = key) => {
    if (!obj || typeof obj[key] !== 'function' || obj[key].__smooth) return;
    const original = obj[key];
    function measured(...args) {
      const t=performance.now();let groupRow;
      if(label==='markdown.render'){const input=args[0],slot=this.slots.get(input.key),request=JSON.stringify([input.text,input.sourcePath,input.streaming]);const group=slot?.request===request?'markdown.cached-request':input.streaming?'markdown.fast-render':'markdown.native-request';groupRow=s.calls[group]??={count:0,totalMs:0,maxMs:0};groupRow.count++;}
      const row=s.calls[label] ??= {count:0,totalMs:0,maxMs:0,asyncTotalMs:0}; row.count++;
      try {
        const result=original.apply(this,args);
        if (result && typeof result.then === 'function') result.then(()=>row.asyncTotalMs+=performance.now()-t,()=>row.asyncTotalMs+=performance.now()-t);
        return result;
      } finally { const dt=performance.now()-t; row.totalMs+=dt; row.maxMs=Math.max(row.maxMs,dt);if(groupRow){groupRow.totalMs+=dt;groupRow.maxMs=Math.max(groupRow.maxMs,dt);} }
    }
    measured.__smooth=true; obj[key]=measured; s.restores.push(()=>obj[key]=original);
  };
  for (const kind of ['Timeout','Interval']) {
    const set=window['set'+kind], clear=window['clear'+kind];
    window['set'+kind]=function(fn,ms,...args) {
      if(typeof fn!=='function')return set(fn,ms,...args);
      const stack=new Error().stack;
      let id;
      const row={kind,ms:Number(ms)||0,stack,fires:0,totalMs:0,created:performance.now()};
      id=set(function(...a){ if(kind==='Timeout')s.timers.delete(id); row.fires++;const t=performance.now();try{return fn.apply(this,a);}finally{row.totalMs+=performance.now()-t;} },ms,...args);
      s.timers.set(id,row);return id;
    };
    window['clear'+kind]=function(id){s.timers.delete(id);return clear(id);};
    s.restores.push(()=>{window['set'+kind]=set;window['clear'+kind]=clear;});
  }
  new PerformanceObserver(list=>s.tasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:false});
  new PerformanceObserver(list=>s.shifts.push(...list.getEntries().map(e=>({start:e.startTime,value:e.value,input:e.hadRecentInput,sources:e.sources.map(x=>({cls:x.node?.className,previous:x.previousRect.toJSON(),current:x.currentRect.toJSON()}))})))).observe({type:'layout-shift',buffered:false});
  s.reset=()=>{s.calls={};s.tasks=[];s.shifts=[];s.events=[];s.frames=[];};
  s.attach=()=>{
    const p=app.plugins.plugins['codex-echoink'],v=p.getCodexView?.();
    for(const key of ['saveSettings','saveData','externalizeMessageText','recordPiAnswerSave','getPiConversationMessages','refreshPiConversationProjection'])s.wrap(p,key,'plugin.'+key);
    const run=p.getConversationRunService?.();
    for(const key of ['notify','scheduleSave','refreshTask'])s.wrap(run,key,'run.'+key);
    for(const key of ['renderMessages','scheduleRenderMessages','scheduleMeasureVirtualRows','refreshAgentTasks','renderComposerTransfers','renderTaskPages'])s.wrap(v,key,'view.'+key);
    const home=app.workspace.getLeavesOfType('codex-echoink-home')[0]?.view;
    s.wrap(home,'refresh','workbench.refresh');
    const r=v?.messageListRenderer;
    for(const key of ['render','measureVisibleVirtualRows','layoutMeasuredRows','tryUpdateAssistantTurnMessage','patchProviderReasoning','renderAnswerMarkdown','renderAgentAnswerContent','decorateVisibleRows','renderVirtualRow','buildVirtualRows','scheduleMeasuredRowsRerender'])s.wrap(r,key,'list.'+key);
    s.wrap(r?.answerMarkdown,'render','markdown.render');
    const nativeFs=require('fs');
    for(const key of ['writeFileSync','appendFileSync','writeFile','appendFile'])s.wrap(nativeFs,key,'fs.'+key);
    for(const key of ['writeFile','appendFile'])s.wrap(nativeFs.promises,key,'fs.promises.'+key);
    if(v?.virtualListEl&&s.observedList!==v.virtualListEl){s.mo?.disconnect();s.observedList=v.virtualListEl;s.mo=new MutationObserver(records=>{
      for(const m of records){
        if(m.type!=='childList')continue;
        if(m.target===v.virtualListEl&&m.removedNodes.length)s.events.push({t:performance.now(),type:'list-remove',removed:m.removedNodes.length});
        if(m.target instanceof Element&&m.target.matches('.echoink-answer-markdown-stream,.echoink-answer-markdown-host'))s.events.push({t:performance.now(),type:'answer-replace',removed:m.removedNodes.length,added:m.addedNodes.length});
      }
    });s.mo.observe(v.virtualListEl,{childList:true,subtree:true});}
  };
  s.snapshot=()=>({calls:s.calls,tasks:s.tasks,shifts:s.shifts,events:s.events,frames:s.frames,timers:[...s.timers.values()].filter(x=>x.stack?.includes('plugin:codex-echoink')),animations:document.getAnimations().map(a=>({name:a.animationName,state:a.playState,iterations:a.effect?.getTiming().iterations===Infinity?'Infinity':a.effect?.getTiming().iterations,target:a.effect?.target?.className,visible:!!a.effect?.target?.getClientRects().length}))});
  s.watchFrames=(duration=1200)=>{
    const start=performance.now(),v=app.plugins.plugins['codex-echoink'].getCodexView();let last;
    return new Promise(resolve=>{
      const step=t=>{
        const d=v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node'),b=d?.querySelector('.codex-ai-elements-reasoning-content');
        const rows=[...v.virtualListEl.children];
        const current={t:performance.now()-start,observedAt:performance.now(),scroll:v.messagesEl.scrollTop,open:d?.open,body:b?{h:b.clientHeight,sh:b.scrollHeight,top:b.scrollTop,max:getComputedStyle(b).maxHeight,overflow:getComputedStyle(b).overflowY}:null,rows:rows.map(e=>({id:e.dataset.rowId,y:e.getBoundingClientRect().y,h:e.getBoundingClientRect().height})),sameRoot:last===d};
        s.frames.push(current);last=d;
        if(t-start<duration)requestAnimationFrame(step);else resolve();
      }; requestAnimationFrame(step);
    });
  };
})();
