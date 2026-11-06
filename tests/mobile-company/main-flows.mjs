import assert from 'node:assert/strict';

export async function mainFlows({ fixture, scriptedModel, test, waitFor, tick, answer, textOf }) {
  const close = async f => { f.company.dispose(); await f.runtime.shutdown('app_closed'); f.runtime.dispose(); };
  const dispatchModel = worker => scriptedModel({ on: (role, user) => role === 'router' && user === '开始' ? ['task_dispatch', { agentId: 'generalist', brief: '完成原任务' }] : role === 'worker' ? worker(user) : null });
  await test('module ownership gates the same dispatch and assigning the saved owner starts exactly once', async () => {
    const model = scriptedModel({ on: (role,user) => role === 'router' && user === '开始' ? ['task_dispatch', { moduleId: 'journal', brief: '整理日记' }] : role === 'worker' ? ['report_to_router', { outcome: 'done', summary: '日记整理好' }] : null });
    const f = await fixture(model); try {
      const id = f.store.session.id; f.settings.agentRegistry.moduleOwners.journal = ''; await f.runtime.send('开始', id);
      assert.equal(f.service.doc.dispatches.length, 0); const request = f.service.pendingModuleAssignments(id)[0]; assert.ok(request);
      f.settings.agentRegistry.moduleOwners.journal = 'generalist';
      await Promise.all([f.service.retryModuleAssignment(request.id), f.service.retryModuleAssignment(request.id)]);
      await waitFor(() => f.service.doc.dispatches[0]?.status === 'done'); assert.equal(f.service.doc.dispatches.length, 1);
      assert.match(f.service.roster(), /journal.*generalist/u);
    } finally { await close(f); }
  });
  await test('real multi-question broker accepts multiple choices and a free-text supplement', async () => {
    const model = dispatchModel(() => ['user_question', { questions: [
      { questionId: 'q1', prompt: '选择资料', selection: 'multiple', options: [{ optionId:'a', label:'甲' },{ optionId:'b', label:'乙' }], allowSupplement:false },
      { questionId: 'q2', prompt: '说明要求', selection: 'single', options: [{ optionId:'a', label:'短' },{ optionId:'b', label:'长' }], allowSupplement:true }
    ] }]);
    const f = await fixture(model); try {
      await f.runtime.send('开始'); await waitFor(() => f.store.getSession(f.service.doc.dispatches[0]?.id)?.interaction?.status === 'pending');
      const d = f.service.doc.dispatches[0], q = f.store.getSession(d.id).interaction;
      await f.runtime.answerQuestion(d.id, q.runId, q.questionId, [{ questionId:'q1', selectedOptionIds:['a','b'] }, { questionId:'q2', selectedOptionIds:[], supplement:'保留原文事实' }]);
      await waitFor(() => f.service.dispatchOf(d.id).status === 'done');
      assert.equal(f.store.getSession(d.id).interaction.answers[1].supplement,'保留原文事实');
    } finally { await close(f); }
  });
  await test('router text answers the existing question without queuing another worker turn', async () => {
    const model = dispatchModel(() => ['user_question', { questions:[{ questionId:'tone', prompt:'选语气', selection:'single', options:[{optionId:'light',label:'轻松'},{optionId:'formal',label:'正式'}],allowSupplement:true }] }]);
    const f = await fixture(model); try {
      const id=f.store.session.id; await f.runtime.send('开始'); await waitFor(() => f.store.getSession(f.service.doc.dispatches[0]?.id)?.interaction?.status === 'pending');
      const d=f.service.doc.dispatches[0]; await f.service.message(id,d.id,'轻松');
      await waitFor(() => f.service.dispatchOf(d.id).status === 'done'); assert.equal(f.store.getSession(d.id).queue?.length ?? 0,0);
      assert.equal(f.store.getSession(d.id).interaction.answers[0].selectedOptionIds[0],'light');
    } finally { await close(f); }
  });
  for (const mode of ['user','assistant','defer','failure']) await test(`write approval mode ${mode} preserves the real ticket and file effect`, async () => {
    const model=dispatchModel(() => ['note_create',{path:'笔记/审批成果.md',content:'通过真实员工写入'}]);
    const request=model.request;
    model.request=async raw => { const body=JSON.parse(raw.body); if(textOf(body.messages[0]).includes('〔员工操作审批〕')) {
      assert.deepEqual((body.tools ?? []).map(t=>t.function?.name??t.name),['approval_decide']);
      if(mode==='failure')throw Error('fixture offline');
      return body.messages.at(-1).role==='tool'?answer('openai-completions','判断结束'):answer('openai-completions','',[[`decision-${Date.now()}`,'approval_decide',{decision:mode==='defer'?'defer':'approve',reason:'原任务要求保存这份成果'}]]);
    } return request(raw); };
    const f=await fixture(model); try {
      f.settings.agentRegistry.agents.find(a=>a.id==='sol').companyApprovalMode=mode==='user'?'user':'assistant';
      await f.runtime.send('开始'); await waitFor(()=>f.service.doc.dispatches.length>0);
      const id=f.service.doc.dispatches[0].id;
      if(mode!=='assistant') {
        await waitFor(()=>f.store.getSession(id).interaction?.status==='pending' && !f.runtime.isCompanyApprovalJudging(id));
        assert.equal(f.files.has('笔记/审批成果.md'),false);
        if (mode === 'user') {
          await f.runtime.shutdown('app_backgrounded'); await f.runtime.foreground(); await f.service.initialize();
          await waitFor(()=>f.store.getSession(id).interaction?.status==='pending');
          assert.equal(f.runtime.stateFor(id).resumeReview,undefined,'unapproved write was never executed');
        }
        const q=f.store.getSession(id).interaction; await f.runtime.answerQuestion(id,q.runId,q.questionId,[{questionId:q.questions[0].questionId,selectedOptionIds:['approve']}]);
      }
      await waitFor(()=>f.service.dispatchOf(id).status==='done'); assert.equal(f.files.get('笔记/审批成果.md'),'通过真实员工写入');
      assert.ok(!model.calls.find(c=>c.role==='router').tools.includes('approval_decide'));
    } finally { await close(f); }
  });
  await test('delete confirmation always stays human even with assistant approvals enabled', async()=>{
    const model=dispatchModel(()=>['user_question',{kind:'confirmation',questions:[{questionId:'delete',prompt:'删除旧文件吗？',selection:'single',options:[{optionId:'approve',label:'批准'},{optionId:'deny',label:'拒绝'}],allowSupplement:false}]}]);
    const f=await fixture(model);try{
      f.settings.agentRegistry.agents.find(a=>a.id==='sol').companyApprovalMode='assistant';await f.runtime.send('开始');
      await waitFor(()=>f.store.getSession(f.service.doc.dispatches[0]?.id)?.interaction?.status==='pending');
      assert.equal(f.runtime.isCompanyApprovalJudging(f.service.doc.dispatches[0].id),false);
    }finally{await close(f);}
  });
  await test('card downgrade freezes dispatched work and blocks project folder creation', async()=>{
    const model=dispatchModel(()=>['report_to_router',{outcome:'done',summary:'只读检查完成'}]);const f=await fixture(model);try{
      const id=f.store.session.id; await f.store.patchSession(id,{draftContext:{attachments:[],selectedPermission:'read-only'}});
      await f.runtime.send('开始');await waitFor(()=>f.service.doc.dispatches[0]?.status==='done');
      assert.equal(f.service.doc.dispatches[0].permission,'read-only');assert.ok(!model.calls.find(c=>c.role==='worker').tools.includes('note_create'));
      await f.service.propose(id,{name:'只读项目',background:'测试',goal:'检查',criteria:['完成'],roles:{},plan:[{id:'t1',agentId:'generalist',moduleId:'none',label:'检查',brief:'检查',dependsOn:[]}]});
      assert.match(await f.service.start(id,f.service.projectForRouter(id).id),/只读/u);assert.equal(f.folders.length,0);
    }finally{await close(f);}
  });
  await test('foreground keeps uncertain writes pending; reviewed continuation settles the same dispatch', async()=>{
    let held=false,release;const hold=new Promise(r=>release=r);const model=dispatchModel(()=>['report_to_router',{outcome:'done',summary:'核对后完成'}]);const request=model.request;
    model.request=async raw=>{if(!held && textOf(JSON.parse(raw.body).messages[0]).includes('<echoink_company_worker')){held=true;await hold;}return request(raw);};
    const f=await fixture(model);try{
      await f.runtime.send('开始');await waitFor(()=>held);const id=f.service.doc.dispatches[0].id,hash='a'.repeat(64);
      await f.store.updateSession(id,t=>{t.operations=[{id:'uncertain',taskId:id,runId:t.runs.at(-1).id,toolCallId:'external',toolName:'mcp_write',semanticKey:`mcp_write:fixture/write:${hash}`,status:'uncertain',createdAt:Date.now(),updatedAt:Date.now(),target:'fixture/write',expectedHash:hash,mcp:{resourceId:'fixture',toolName:'write'}}];});
      await f.runtime.shutdown('app_backgrounded');release();await f.runtime.foreground();await f.service.initialize();
      assert.equal(f.service.dispatchOf(id).status,'waiting');const review=f.runtime.stateFor(id).resumeReview;assert.equal(review.issues.length,1);
      await f.service.resumeAfterReview(id,review.fingerprint);await waitFor(()=>f.service.dispatchOf(id).status==='done');assert.equal(f.service.dispatchOf(id).report.outcome,'done');
    }finally{await close(f);}
  });
  await test('old card keeps its history and identity; direct employee completion records bounded background only', async()=>{
    const model=dispatchModel(()=>['report_to_router',{outcome:'done',summary:'原卡交付'}]);const f=await fixture(model);try{
      const id=f.store.session.id;await f.runtime.send('旧卡历史');const old=f.store.getSession(id).messages;await f.store.patchSession(id,{companyRole:undefined});
      await f.runtime.send('开始');await waitFor(()=>f.service.doc.dispatches[0]?.status==='done');assert.equal(f.store.getSession(id).companyRole,'router');assert.deepEqual(f.store.getSession(id).messages.slice(0,old.length),old);
      const employee=await f.store.createSession('generalist');await f.runtime.send('直接员工任务',employee.id);await waitFor(()=>f.service.doc.staffActivities?.length===1);
      assert.equal(f.service.doc.staffActivities[0].title,'直接员工任务');assert.equal(f.service.doc.dispatches.length,1);
    }finally{await close(f);}
  });
}
