import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {vault} from './cdp.mjs';

const root=process.cwd(),entries={
  publication:'import {runPiChatUiProjectorTests} from "./src/tests/harness-v2/pi-chat-ui-projector"; await runPiChatUiProjectorTests(); import {runBufferedModelProgressTests} from "./src/tests/pi-native/pi-native-conversation-runtime"; import {runPiKnowledgeResilienceTests} from "./src/tests/pi-native/knowledge-resilience"; await runBufferedModelProgressTests(); await runPiKnowledgeResilienceTests();',
  markdown:'import {runAnswerMarkdownTests} from "./src/tests/answer-markdown"; await runAnswerMarkdownTests();'
};
const entry=entries[process.argv[2]];if(!entry)throw Error('Select a named focused suite');
const dir=path.join(vault,'.obsidian/perf-tests');await fs.mkdir(dir,{recursive:true});
const file=path.join(dir,'runtime-smoothness-focused.mjs');
await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,platform:'node',target:'node22',format:'esm',outfile:file,
  banner:{js:`import {createRequire as createPerfRequire} from 'node:module';const require=createPerfRequire(${JSON.stringify(path.join(root,'package.json'))});`},
  loader:{'.md':'text','.svg':'dataurl','.webp':'dataurl'},logLevel:'silent',
  plugins:[{name:'focused-host',setup(b){
    b.onResolve({filter:/^(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?|yaml|jsdom)$/},args=>({path:fileURLToPath(import.meta.resolve(args.path)),external:true}));
    b.onResolve({filter:/provider-brand-icons$/},()=>({path:path.join(root,'src/tests/composer-provider-brand-shim.ts')}));
    b.onResolve({filter:/^obsidian$/},()=>({path:path.join(root,'src/tests/obsidian-shim.ts')}));
  }}]});
const result=spawnSync(process.execPath,[file],{env:{...process.env,PI_OFFLINE:'1'},stdio:'inherit'});
process.exitCode=result.status??1;
