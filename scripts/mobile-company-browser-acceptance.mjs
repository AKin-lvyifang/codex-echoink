import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.ECHOINK_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = process.env.ECHOINK_COMPANY_EVIDENCE ?? 'docs/internal/test-evidence/2026-11-06-2.8.10收公司电脑分支-推进记录/mobile-company';
await fs.mkdir(directory,{recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const results=[];
try {
  for (const tablet of [false,true]) {
    const device=tablet?'ipad':'iphone',context=await browser.newContext({viewport:tablet?{width:1208,height:1000}:{width:390,height:844}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const shot=async name=>{await page.screenshot({path:path.join(directory,`${device}-${name}.png`)});};
    await page.goto(`http://127.0.0.1:8786/?company&host${tablet?'&tablet':''}`);
    await page.waitForFunction(()=>!!window.mobileFixture);
    await page.getByRole('button',{name:'新任务',exact:true}).click();
    await page.getByRole('textbox',{name:'新任务草稿'}).fill('做一期一人公司发布介绍');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.waitForFunction(()=>window.mobileFixture.company.service.doc.projects.length===1 && !window.mobileFixture.runtime.isBusy(window.mobileFixture.company.service.doc.projects[0].routerConversationId));
    await page.locator('.emc-start-details > summary').click();await shot('proposal');
    await page.getByRole('button',{name:'开工',exact:true}).click();
    await page.waitForFunction(()=>window.mobileFixture.store.state.sessions.some(s=>s.companyRole==='worker'&&s.interaction?.status==='pending'));
    await page.locator('.emc-reminder').click();
    await page.getByRole('button',{name:'新用户',exact:true}).click();
    await page.getByRole('button',{name:'总助派活',exact:true}).click();
    await page.getByRole('button',{name:'统一审批',exact:true}).click(); await page.locator('.emc-decision:visible textarea').fill('保留事实'); const questionButton=await page.getByRole('button',{name:'新用户',exact:true}).elementHandle(); await page.evaluate(()=>window.mobileFixture.runtime.onChange()); assert.equal(await questionButton.evaluate(e=>e.isConnected),true,'background progress must preserve the mounted answer form'); assert.equal(await page.locator('.emc-decision:visible textarea').evaluate(e=>e===document.activeElement && e.value==='保留事实'),true,'progress must keep the current answer and typing focus'); await shot('questions');
    await page.getByRole('button',{name:'确认选择',exact:true}).click();
    await page.locator('.emc-decision.is-approval:visible').waitFor();await shot('approval');
    // These are the same app lifecycle methods invoked by visibilitychange, with no iOS background claim.
    await page.evaluate(async()=>{const f=window.mobileFixture;await f.runtime.shutdown('app_backgrounded');await f.runtime.foreground();await f.company.service.initialize();});
    await page.locator('.emc-decision.is-approval:visible').waitFor();await shot('foreground');
    await page.locator('.emc-decision.is-approval:visible').getByRole('button',{name:'批准',exact:true}).click();
    await page.waitForFunction(()=>window.mobileFixture.company.service.doc.dispatches.some(d=>d.planTaskId==='write'));
    await page.locator('.emc-decision.is-approval:visible').getByRole('button',{name:'批准',exact:true}).click();
    await page.waitForFunction(()=>window.mobileFixture.company.service.doc.projects[0]?.status==='done'); await page.locator('.eis-scroll:visible, .echoink-ipad-content:visible').evaluateAll(es=>es.forEach(e=>{e.scrollTop=0;})); await shot('completed');
    const state=await page.evaluate(()=>{const f=window.mobileFixture,p=f.company.service.doc.projects[0];return {project:p,dispatches:f.company.service.doc.dispatches,files:[...f.host.files].filter(([p])=>p.startsWith('项目/')&&p.endsWith('.md'))};});
    assert.equal(state.dispatches.length,2);assert.ok(state.dispatches.every(d=>d.status==='done'));assert.equal(state.files.length,2);
    await page.getByRole('tab',{name:/产出/}).click();await page.locator('.emc-output').first().click();
    await page.waitForFunction(()=>!!window.mobileFixture.workspaceFixture.active?.file?.path); await shot('output');
    // Return to the same router card and continue, preserving its identity and history.
    await page.getByRole('button',{name:'首页标签',exact:true}).click(); if(await page.locator('.emc-project:visible').count()) await page.locator('.emc-project:visible').first().click();
    await page.getByRole('button',{name:'对话',exact:true}).click();
    const count=await page.evaluate(()=>{const f=window.mobileFixture,p=f.company.service.doc.projects[0];return f.store.getSession(p.routerConversationId).messages.length;});
    await page.getByRole('textbox',{name:'任务回复草稿'}).fill('接着说原来的事');await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.waitForFunction(count=>{const f=window.mobileFixture,p=f.company.service.doc.projects[0];return !f.runtime.isBusy(p.routerConversationId)&&f.store.getSession(p.routerConversationId).messages.length>count;},count);
    assert.equal(await page.locator('.ip-task-user:visible, .pd-task-user:visible').filter({hasText:'〔员工汇报〕'}).count(),0); await shot('old-card');assert.deepEqual(errors,[]);
    results.push({device,passed:true,project:state.project.name,dispatches:state.dispatches.map(d=>({agent:d.agentId,status:d.status,turns:d.turns})),files:state.files.map(([p])=>p),errors});
    await context.close();
    const soloContext=await browser.newContext({viewport:tablet?{width:1208,height:1000}:{width:390,height:844}}),soloPage=await soloContext.newPage();
    await soloPage.goto(`http://127.0.0.1:8786/?company&host${tablet?'&tablet':''}`);await soloPage.waitForFunction(()=>!!window.mobileFixture);
    await soloPage.getByRole('button',{name:'新任务',exact:true}).click();await soloPage.getByRole('textbox',{name:'新任务草稿'}).fill('请派一个小活');await soloPage.getByRole('button',{name:'发送',exact:true}).click();
    await soloPage.locator('.emc-reminder:visible').waitFor(); if(tablet){ await soloPage.getByRole('button',{name:'搜索笔记',exact:true}).click(); await soloPage.locator('.pd-search-page:visible').waitFor(); } await soloPage.locator('.emc-reminder:visible').click();await soloPage.locator('.emc-home-decisions:visible').waitFor();
    await soloPage.screenshot({path:path.join(directory,`${device}-small-wait.png`)});
    await soloPage.evaluate(async()=>{const f=window.mobileFixture,d=f.company.service.doc.dispatches[0];await f.company.service.stop(d.routerConversationId,d.id);});
    results.at(-1).singleTaskReminder=true;await soloContext.close();
  }
} finally { await browser.close();await fs.writeFile(path.join(directory,'mobile-browser-results.json'),JSON.stringify(results,null,2)); }
console.log(JSON.stringify(results,null,2));
