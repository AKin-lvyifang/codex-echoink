import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { englishFixture, responseFor } from "./host.mjs";
import { answer } from "../mobile/host.mjs";
const sourcePath = "journal/2026-10-19.md";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async condition => { for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error("condition not reached"); };
const privacy = inspected => ({ sourceFingerprint: inspected.privacy.sourceFingerprint, rules: inspected.blocks.map(block => ({ blockId: block.id, mode: block.text.includes("PRIVATE") ? "exclude" : "translate" })) });
const hash = text => createHash("sha256").update(text,"utf8").digest("hex");
const make = async (api, root, name, seed) => englishFixture(api, path.join(root, name), seed);

export async function runEnglishScenarios(api, root) {
  for (const text of ["", "日记😀\r\nline", "a\u0000b", "\ud800", "x".repeat(1024*1024)]) assert.equal(api.fingerprint(text), hash(text));
  const f = await make(api,root,"generation"); f.reset();
  const empty = await f.service.readPage(); assert.equal(empty.diaryCount,0); assert.equal(empty.expressionCount,0);
  const sources = await f.service.listSources(); assert.equal(sources.length,1); assert.equal(sources[0].date,"2026-10-19");
  let inspected = await f.service.inspectSource(sourcePath); assert.equal(inspected.privacyReviewRequired,false);
  assert.equal(f.calls.writes.length,0); assert.equal(f.calls.model,0);
  await assert.rejects(f.service.inspectSource("outside/not-daily.md"),/原文/u);
  const provider = await f.service.readProvider(); assert.equal(provider.approved,false);
  await assert.rejects(f.service.api.generate(sourcePath,{privacy:privacy(inspected)}),/确认/u); assert.equal(f.requests.length,0);
  await f.approve(); f.reset();
  let release;
  f.request(params => new Promise(resolve => { release=()=>{const body=JSON.parse(params.body);resolve(answer("openai-completions",responseFor(body.messages.find(item=>item.role==="user").content)));}; }));
  const first=f.service.api.generate(sourcePath,{privacy:privacy(inspected)}), duplicate=f.service.api.generate(sourcePath,{privacy:privacy(inspected)});
  assert.equal(first,duplicate,"same workspace request uses original service owner/promise");
  await assert.rejects(f.service.api.generate(sourcePath,{owner:"agent"}),/另一处/u);
  await waitFor(()=>release); const requestText=f.requests[0].body; assert.ok(!requestText.includes("PRIVATE-MEDICAL-DETAIL"));
  release(); const saved=await first;
  assert.ok(saved.result); assert.equal(f.requests.length,1); assert.equal(f.usage.length,1); assert.equal(saved.result.expressions.length,1);
  const disk=await f.read(saved.englishPath); assert.ok(disk.includes("worked up the courage")); assert.ok(disk.includes("PRIVATE-MEDICAL-DETAIL"),"excluded text stays locally in the rendered diary");
  const cold=f.cold(); f.reset();
  let detail=await cold.readSaved(saved.id); assert.equal(detail.canAlign,true); assert.equal(detail.englishMarkdown,disk);
  let page=await cold.readPage(); assert.equal(page.diaryCount,1); assert.equal(page.expressionCount,1);
  assert.equal(f.calls.writes.length,0); assert.equal(f.calls.model,1);
  f.paid(false); f.settings.apiProviders=[];
  detail=await cold.readSaved(saved.id); page=await cold.readPage(); assert.equal(detail.englishMarkdown,disk); assert.equal(page.expressionCount,1); assert.equal(f.calls.writes.length,0);
  await assert.rejects(cold.api.generate(sourcePath,{force:true,privacy:privacy(inspected)}),/PRO/u);
  await f.write(saved.englishPath,disk+"\nMy manual edit\n"); detail=await cold.readSaved(saved.id); assert.equal(detail.canAlign,false); assert.ok(detail.englishMarkdown.includes("My manual edit"));
  await f.write(sourcePath,"Changed original"); detail=await cold.readSaved(saved.id); assert.equal(detail.canAlign,false); assert.ok(detail.errors.length);
  await fs.unlink(f.full(sourcePath)); detail=await cold.readSaved(saved.id); assert.equal(detail.source,null); assert.equal(detail.canAlign,false); cold.dispose(); f.service.dispose();
  console.log("PASS real disk generation: live PRO after construction; inspect/list zero writes; provider confirmation; exact duplicate ownership; real request excludes private block; usage; durable diary/expressions; cold/no-model/expired-PRO reads; actual edited Markdown and missing source disable alignment.");

  const edit=await make(api,root,"expression-edit"); await edit.approve();
  const input=await edit.service.inspectSource(sourcePath);const generated=await edit.service.api.generate(sourcePath,{privacy:privacy(input)});
  const initialPage=await edit.service.readPage(), entry=initialPage.expressions[0],version=initialPage.expressionVersions[entry.id];
  await edit.service.saveExpression(entry.id,{category:"My category",note:"My original note"},version);
  await assert.rejects(edit.service.saveExpression(entry.id,{category:"Old draft",note:"stale"},version),/变化/u);
  const fresh=await edit.service.readPage();assert.equal(fresh.expressions[0].note,"My original note");
  const before=await edit.read(fresh.expressions[0].path); let failed=false;
  edit.hooks({write(relative){if(!failed&&relative===fresh.expressions[0].path){failed=true;throw Error("disk save failed");}}});
  await assert.rejects(edit.service.saveExpression(entry.id,{category:"Failure",note:"retained draft"},fresh.expressionVersions[entry.id]));
  assert.equal(await edit.read(fresh.expressions[0].path),before); edit.hooks({});
  assert.ok((await edit.service.readSaved(generated.id)).record.result);
  const settings=await edit.service.readSettings();edit.hooks({save(){throw Error("settings unavailable");}});
  await assert.rejects(edit.service.saveSettings({homeShortcut:"english-diary"},settings.version));
  assert.equal((await edit.service.readSettings()).settings.homeShortcut,settings.settings.homeShortcut);edit.hooks({});
  await edit.service.saveSettings({homeShortcut:"english-diary"},settings.version);
  await assert.rejects(edit.service.saveSettings({homeShortcut:"quick-record"},settings.version),/变化/u);
  const current=await edit.service.readSettings(); await assert.rejects(edit.service.saveSettings({approvedProvider:"forged"},current.version),/批准/u);
  const approved=await edit.service.readProvider(); edit.settings.apiProviders[0].baseUrl="https://changed.invalid/v1";
  await assert.rejects(edit.service.approveProvider(approved.version),/变化/u); assert.equal((await edit.service.readProvider()).approved,false);
  edit.settings.englishDiary.providerSettingsId="missing-provider";edit.settings.englishDiary.modelId="missing-model";
  await assert.rejects(edit.service.readProvider(),/不存在/u);assert.equal((await edit.service.readSaved(generated.id)).record.id,generated.id);
  const legacyStatePath = `.obsidian/plugins/echoink/english-diary/${generated.id}.json`;
  const legacyState = JSON.parse(await edit.read(legacyStatePath));
  legacyState.englishPath = "输出（outputs）/英文日记/existing.md";
  const legacy = await make(api, root, "legacy-bilingual", {
    [legacyStatePath]: JSON.stringify(legacyState), [legacyState.englishPath]: await edit.read(generated.englishPath)
  });
  legacy.settings.knowledgeBase.folderBindings = null; legacy.reset();
  const legacyDetail = await legacy.service.readSaved(generated.id);
  assert.equal(legacyDetail.canAlign, true); assert.ok(legacyDetail.englishMarkdown.includes("worked up the courage"));
  legacyState.result.english = "Corrupted cached English";
  await legacy.write(legacyStatePath, JSON.stringify(legacyState));
  const mismatched = await legacy.service.readSaved(generated.id); assert.equal(mismatched.canAlign, false); assert.ok(mismatched.englishMarkdown.includes("worked up the courage"));
  assert.equal(legacy.calls.writes.length, 0); legacy.service.dispose();
  edit.service.dispose();console.log("PASS expression/settings versions: real Markdown mutation, stale-version rejection, failed-save byte preservation, settings rollback/version, forged/stale provider approval rejection and dedicated-model no fallback.");

  const privacyCase=await make(api,root,"privacy-changed");await privacyCase.approve();
  const original=await privacyCase.service.inspectSource(sourcePath);await privacyCase.service.api.generate(sourcePath,{privacy:privacy(original)});
  await privacyCase.write(sourcePath,(await privacyCase.read(sourcePath)).replace("PRIVATE-MEDICAL-DETAIL","EDITED-PRIVATE-SECRET"));privacyCase.reset();
  const review=await privacyCase.service.inspectSource(sourcePath);assert.equal(review.privacyReviewRequired,true);assert.ok(review.privacy.rules.every(rule=>rule.mode==="exclude"));assert.equal(privacyCase.calls.writes.length,0);privacyCase.service.dispose();
  console.log("PASS privacy changed: invalid old secret rule conservatively becomes all-exclude, review required, zero inspect writes.");

  for(const scenario of ["cancel","background","source-edit","target-edit","pro-revoke","skill-revoke","model-change"]){
    const running=await make(api,root,scenario);await running.approve();const inspect=await running.service.inspectSource(sourcePath);
    let finish;running.request(params=>new Promise(resolve=>{finish=()=>{const body=JSON.parse(params.body);resolve(answer("openai-completions",responseFor(body.messages.find(item=>item.role==="user").content)));};}));
    const pending=running.service.api.generate(sourcePath,{privacy:privacy(inspect)});await waitFor(()=>finish);
    const stateFiles=(await running.adapter.list(".obsidian/plugins/echoink/english-diary")).files.filter(name=>/[a-f0-9]{24}\.json$/u.test(name));const state=JSON.parse(await running.read(stateFiles[0]));
    if(scenario==="cancel")running.service.api.cancel(sourcePath,"workspace");
    if(scenario==="background")running.service.cancelWorkspace();
    if(scenario==="source-edit")await running.write(sourcePath,"New source after request");
    if(scenario==="target-edit")await running.write(state.englishPath,"My newer file");
    if(scenario==="pro-revoke")running.paid(false);
    if(scenario==="skill-revoke")running.skill(false);
    if(scenario==="model-change"){running.settings.apiProviders[0].baseUrl="https://other.invalid/v1";running.service.settingsChanged();}
    finish();await assert.rejects(pending);assert.equal(await running.adapter.exists(state.englishPath),scenario==="target-edit");
    if(scenario==="target-edit")assert.equal(await running.read(state.englishPath),"My newer file");
    running.service.dispose();assert.equal(running.vaultEvents.size,0);
  }
  console.log("PASS late responses: cancel/background/source edit/target edit/PRO revocation/Skill revocation/model changes cannot publish or overwrite current files.");
  const owner=await make(api,root,"agent-owner");await owner.approve();const inspect=await owner.service.inspectSource(sourcePath);let finish;
  owner.request(params=>new Promise(resolve=>{finish=()=>{const body=JSON.parse(params.body);resolve(answer("openai-completions",responseFor(body.messages.find(item=>item.role==="user").content)));};}));
  const agent=owner.service.api.generate(sourcePath,{owner:"agent",privacy:privacy(inspect)});await waitFor(()=>finish);owner.service.cancelWorkspace();finish();assert.ok((await agent).result);owner.service.dispose();
  console.log("PASS ownership: page background cancellation affects workspace only; existing Agent generation completes.");
  const unrelated = await make(api, root, "unrelated-settings"); await unrelated.approve();
  const unrelatedInput = await unrelated.service.inspectSource(sourcePath); let finishUnrelated;
  unrelated.request(params => new Promise(resolve => { finishUnrelated = () => {
    const body = JSON.parse(params.body); resolve(answer("openai-completions", responseFor(body.messages.find(item => item.role === "user").content)));
  }; }));
  const kept = unrelated.service.api.generate(sourcePath, { privacy: privacy(unrelatedInput) });
  await waitFor(() => finishUnrelated);
  unrelated.settings.settingsLanguage = "en"; unrelated.settings.echoinkColorTheme = "purple";
  await unrelated.services.saveSettings(); unrelated.service.settingsChanged();
  finishUnrelated(); assert.ok((await kept).result); unrelated.service.dispose();
  console.log("PASS unrelated settings saves: language/theme changes notify without cancelling the workspace generation.");
  const uncertain=await make(api,root,"unknown-transaction");
  await uncertain.write(".obsidian/plugins/echoink/english-diary/expression-operation.json",JSON.stringify({schema:1,phase:"apply",changes:[]}));uncertain.reset();
  const reopened=uncertain.cold();const unknown=await reopened.readPage();assert.equal(unknown.expressionCount,null);await assert.rejects(reopened.api.generate(sourcePath),/确认|重放/u);
  assert.equal(uncertain.calls.writes.length,0);assert.equal(uncertain.requests.length,0);assert.ok(await uncertain.adapter.exists(".obsidian/plugins/echoink/english-diary/expression-operation.json"));reopened.dispose();uncertain.service.dispose();
  const denied=await make(api,root,"unapproved-directory");denied.settings.knowledgeBase.folderBindings.roles.outputs.allowedSubdirectories=[];denied.reset();
  await denied.service.readPage();await denied.service.inspectSource(sourcePath);await assert.rejects(denied.service.api.generate(sourcePath),/子目录|确认/u);assert.equal(denied.calls.writes.length,0);denied.service.dispose();
  await tick();console.log("PASS interrupted cold start and unapproved output child: no recovery, replay, implicit migration or folder creation; actual unknown counts preserved.");
}
