import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchTavily, TavilyError, type TavilyTransport } from "../tools/tavily-search";
import { normalizeSettingsData } from "../settings/settings";
import { PiWebSearchSecurity, createWebSearchTool } from "../harness/pi-native/pi-web-search";
import { ConversationAutoArchive } from "../plugin/conversation-auto-archive";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../harness/pi-native/controlled-resources";
import { createPiVaultToolSecurityAdapter } from "../harness/pi-native/pi-vault-tool-security-extension";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { piWorkspaceAllowsTool } from "../harness/pi-native/pi-workspace-access";

const secret = "test-only-noncredential";
const settings = { enabled: false, apiKey: secret };
let requests = 0;
const transport: TavilyTransport = async request => {
  requests++;
  assert.equal(request.url, "https://api.tavily.com/search");
  assert.equal(request.headers.Authorization, `Bearer ${secret}`);
  const body = JSON.parse(request.body);
  assert.equal(body.search_depth, "basic"); assert.equal(body.auto_parameters, false); assert.equal(body.include_answer, false);
  assert.deepEqual(Object.keys(body).sort(), ["query", "search_depth", "auto_parameters", "max_results", "include_answer", "include_raw_content"].sort());
  return { status: 200, json: { results: [{ title: "Source", url: "https://example.com/news", content: "Public evidence", published_date: "2026-09-21" }] } };
};
const result = await searchTavily({ apiKey: secret, query: "current news", maxResults: 1, transport });
assert.deepEqual(result.results[0], { title: "Source", url: "https://example.com/news", summary: "Public evidence", publishedDate: "2026-09-21" });
for (const [status, code] of [[401,"key_invalid"],[403,"key_invalid"],[432,"quota"],[429,"rate_limit"],[500,"network"]] as const) {
  await assert.rejects(searchTavily({ apiKey: secret, query: "news", transport: async () => ({status, json: { error: secret }}) }), (error: unknown) => error instanceof TavilyError && error.code === code && !error.message.includes(secret));
}
await assert.rejects(searchTavily({ apiKey: secret, query: "news", timeoutMs: 1, transport: async () => new Promise(() => {}) }), /tavily_timeout/);
const abort = new AbortController(); abort.abort();
await assert.rejects(searchTavily({ apiKey: secret, query: "news", signal: abort.signal, transport }), /tavily_cancelled/);
assert.equal(normalizeSettingsData({}).settings.tavily.enabled, false);
assert.equal(normalizeSettingsData({}).settings.autoArchiveDays, 0);
const restored = normalizeSettingsData(JSON.parse(JSON.stringify({ tavily: { enabled: true, apiKey: secret }, autoArchiveDays: 14 }))).settings;
assert.deepEqual(restored.tavily, { enabled: true, apiKey: secret }); assert.equal(restored.autoArchiveDays, 14);
assert.equal(normalizeSettingsData({ tavily: { enabled: true, apiKey: " " }, autoArchiveDays: 8 }).settings.tavily.enabled, false);
assert.equal(normalizeSettingsData({autoArchiveDays: 8}).settings.autoArchiveDays, 0);

const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-tools-archive-")));
try {
  // Real Pi AgentSession + native ProductRun, with controlled provider and HTTP responses.
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root,"runtime"), vaultId: "tool-fixture" });
  const runs = new FileProductRunStore({ storageRootPath: path.join(root,"runtime"), vaultId: catalog.vaultId, catalog });
  let factories = 0;
  let provider: ReturnType<typeof fauxProvider>;
  let sec: PiWebSearchSecurity;
  const runtime = new PiNativeConversationRuntime({ catalog, productRuns: runs,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file,dir,cwd) },
    resolveConversationCwd: () => root,
    createAgentSession: async input => {
      factories++;
      sec = new PiWebSearchSecurity(() => settings);
      const tool = createWebSearchTool(sec);
      tool.execute = (id,args,signal) => sec.execute(id,args,signal, request => searchTavily({...request,transport}));
      const gate = createPiVaultToolSecurityAdapter({
        isToolAllowed: name => sec.available() && piWorkspaceAllowsTool({ ...input.currentWorkspaceAccess!()!, toolName: name, planToolNames: [tool.name], memoryToolNames: [], externalReadToolNames: [tool.name] }),
        authorization: { authorize: async () => { throw new Error("no vault writes"); } },
        resultCorrection: { correct: async () => { throw new Error("no vault tools"); } }, additionalToolSecurities: [sec]
      });
      provider = fauxProvider({ provider: "fixture", api: "openai-completions", models: [{id:"fixture",contextWindow:32_000,maxTokens:1024}] });
      const modelRuntime = await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,allowModelNetwork:false});
      modelRuntime.registerNativeProvider(provider.provider);
      const { session } = await createAgentSession({cwd:root,agentDir:root,modelRuntime,model:provider.getModel(),sessionManager:input.sessionManager,
        ...createControlledPiToolRegistration([tool]),
        settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},packages:[],extensions:[],skills:[],prompts:[],themes:[],enableAnalytics:false}),
        resourceLoader:await createControlledVaultResourceLoader({vaultRoot:root,systemPrompt:"Use supplied tools when available.",inlineExtension:gate.inlineExtension}) });
      session.setActiveToolsByName([tool.name]);
      return {session,planToolNames:[tool.name],externalReadToolNames:[tool.name],isToolCurrentlyEnabled: name => name !== tool.name || sec.available()};
    }
  });
  await runtime.initialize();
  try {
    await runtime.createConversation({conversationId:"same",title:"same",cwd:root});
    await runtime.activateConversation("same",{runtimeProviderId:"fixture",modelId:"fixture"});
    const submit = async () => { const run = await runtime.submit({conversationId:"same",text:"latest news",submittedAt:Date.now(),runtimeProviderId:"fixture",modelId:"fixture",permission:"read-only",reasoning:"none"}); return await run.result; };
    const before = requests;
    provider!.setResponses([context => { assert.equal(context.tools?.some(tool => tool.name === "web_search"),false); return fauxAssistantMessage("Search disabled."); }]);
    assert.equal((await submit()).terminalState,"completed"); assert.equal(requests,before);
    settings.enabled = true;
    provider!.setResponses([context => {assert.equal(context.tools?.some(tool => tool.name === "web_search"),true);return fauxAssistantMessage(fauxToolCall("web_search",{query:"current news"},{id:"web-1"}),{stopReason:"toolUse"});},context => {
      const text = JSON.stringify(context.messages); assert.match(text,/https:\/\/example.com\/news/); assert.match(text,/Public evidence/); assert.ok(!text.includes(secret));
      return fauxAssistantMessage("Verified webpage: https://example.com/news");
    }]);
    assert.equal((await submit()).terminalState,"completed"); assert.equal(requests,before+1);
    settings.enabled = false;
    provider!.setResponses([context => { assert.equal(context.tools?.some(tool => tool.name === "web_search"),false);return fauxAssistantMessage("Search disabled again."); }]);
    assert.equal((await submit()).terminalState,"completed"); assert.equal(requests,before+1); assert.equal(factories,1);
    assert.ok((await sec!.handleToolCall({toolCallId:"web-1",toolName:"web_search",input:{query:"current news"},type:"tool_call"} as any))?.block);
    await runtime.readProjection("same"); assert.equal(requests,before+1,"history read never dispatches search");
  } finally { await runtime.shutdown(); }

  let now = 100 * 86_400_000; let days = 0; let refreshes = 0; let errors = 0;
  const archiveCatalog = new FileConversationCatalog({storageRootPath:path.join(root,"archive"),vaultId:"archive-fixture",now:()=>now});
  await archiveCatalog.initialize();
  const old = now - 8 * 86_400_000;
  for (const id of ["old","threshold","recent","viewed","running","queue","pinned","draft","run-recent"]) {
    await archiveCatalog.upsert({conversationId:id,piSessionId:`pi-${id}`,vaultId:archiveCatalog.vaultId,title:id,status:"active",defaultMemoryMode:"normal",createdAt:old,updatedAt:id==="recent"?now:id==="threshold"?now-7*86_400_000:old});
  }
  const protectedIds = new Set(["viewed","running","queue","pinned"]);
  const archiver = new ConversationAutoArchive({days:()=>days,list:()=>archiveCatalog.list({statuses:["active"]}),
    activity:async id => ({updatedAt:id==="run-recent"?now:(await archiveCatalog.get(id))!.updatedAt,hasDrafts:id==="draft"}),
    isProtected:id=>protectedIds.has(id),archive:async id=>{await archiveCatalog.status(id,"archived");},changed:async()=>{refreshes++;},onError:()=>{errors++;}},()=>now);
  await archiver.scan(); assert.equal((await archiveCatalog.get("old"))!.status,"active");
  days=7; archiver.configure(); await archiver.scan();
  assert.equal((await archiveCatalog.get("old"))!.status,"archived"); assert.equal(refreshes,1);
  for (const id of ["threshold","recent","viewed","running","queue","pinned","draft","run-recent"]) assert.equal((await archiveCatalog.get(id))!.status,"active",id);
  await archiveCatalog.status("old","active"); await archiver.scan(); assert.equal((await archiveCatalog.get("old"))!.status,"active","restore resets catalog activity");
  days=0; archiver.configure(); now+=100*86_400_000; await archiver.scan(); assert.equal((await archiveCatalog.get("recent"))!.status,"active");
  await archiver.dispose(); assert.equal(errors,0);
  let unblock!: () => void; let scans = 0; let mutations = 0;
  days = 7;
  const delayed = new ConversationAutoArchive({days:()=>days,
    list:async()=>{scans++;await new Promise<void>(resolve=>{unblock=resolve;});return archiveCatalog.list({statuses:["active"]});},
    activity:async()=>({updatedAt:old,hasDrafts:false}),isProtected:()=>false,
    archive:async()=>{mutations++;},changed:async()=>{},onError:()=>{errors++;}},()=>now);
  delayed.configure(); const first = delayed.scan(); const second = delayed.scan();
  assert.equal(scans,1,"concurrent scans share one flight"); days=0; delayed.configure(); unblock();
  await Promise.all([first,second]); assert.equal(mutations,0,"turning off while awaiting IO prevents subsequent archives");
  await delayed.dispose(); assert.equal(errors,0);
  console.log("Tavily transport, settings persistence, native Pi tool loop/toggle/read-only/replay, and local catalog auto-archive checks passed (controlled responses; pinned protection port only, no existing pin UI).");
} finally { await rm(root,{recursive:true,force:true}); }
