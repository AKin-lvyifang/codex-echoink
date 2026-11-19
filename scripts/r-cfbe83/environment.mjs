import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const evidenceDirectory=path.resolve('docs/internal/test-evidence/2026-11-17-R-CFBE83-建议卡与复制防护');
export async function configureNative(){
 const state=JSON.parse(await fs.readFile(path.join(evidenceDirectory,'native-environment.json'),'utf8'));
 const expected=path.join(os.homedir(),'EchoInk-TestVaults/测试仓库-R-CFBE83验收');
 if(state.vault!==expected)throw Error('Wrong disposable Vault');
 process.env.ECHOINK_PERF_VAULT=expected;process.env.ECHOINK_PERF_PORT=String(state.port);process.env.ECHOINK_PERF_OUT=evidenceDirectory;return state;
}
